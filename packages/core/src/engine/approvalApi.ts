import type { AgentRuntime } from "../runtime/AgentRuntime.js";
import type { Run } from "../protocol/types.js";
import type { Session } from "../define/Session.js";
import type { EngineDeps } from "./types.js";
import type { RunStore } from "../adapters/run/RunStore.js";
import { getAgentDefinition, resolveToolRegistry } from "../define/registry.js";
import {
  ExecutionNotAllowedError,
  ExecutionPolicyError,
  ExecutionWaitError,
  RunInvalidStateError,
} from "../errors/index.js";
import { buildEngineDeps } from "./buildEngineDeps.js";
import {
  appendObservation,
  emitRun,
  emitToolActionEvent,
  evaluateExecutionPolicy,
  executeRun,
  hookRunCtx,
  stableStringHash,
  toolContext,
} from "./Engine.js";
import { observationForToolFailure } from "./toolFailureObservation.js";

/** Shared identity fields for approval APIs (explicit session binding, §6). */
export interface PendingActionRef {
  runId: string;
  actionId: string;
  /** Caller-resolved session; must match the run's project/session/tenant. */
  session: Session;
}

export interface ApprovePendingActionInput extends PendingActionRef {
  /**
   * `execute_and_continue` (default): run the tool, append the observation and
   * continue the engine loop. `execute_only`: run the tool + persist without
   * another LLM turn.
   */
  mode?: "execute_and_continue" | "execute_only";
}

export interface ApprovePendingActionResult {
  run: Run;
  /** Whether the tool actually executed (`false` when policy denied at approval time). */
  executed: boolean;
  /** Stable error code when the policy refused the approved action. */
  deniedCode?: string;
  idempotencyKey?: string;
}

function assertRunBoundToSession(run: Run, session: Session): void {
  if (run.agentId !== "" && session.projectId === "") {
    throw new RunInvalidStateError("session.projectId is required");
  }
  if (run.projectId !== session.projectId) {
    throw new RunInvalidStateError(
      `Run ${run.runId} belongs to a different project`,
    );
  }
  if (run.sessionId != null && run.sessionId !== session.id) {
    throw new RunInvalidStateError(
      `Run ${run.runId} belongs to a different session`,
    );
  }
  if (
    session.tenantId !== undefined
      ? run.tenantId !== session.tenantId
      : run.tenantId !== undefined
  ) {
    throw new RunInvalidStateError(
      `Run ${run.runId} belongs to a different tenant`,
    );
  }
}

function requireApprovalStore(runtime: AgentRuntime): {
  store: RunStore & {
    claimPendingAction: NonNullable<RunStore["claimPendingAction"]>;
  };
} {
  const store = runtime.config.runStore;
  if (!store) {
    throw new ExecutionNotAllowedError(
      "AgentRuntime({ runStore }) is required for approval APIs",
    );
  }
  if (typeof store.claimPendingAction !== "function") {
    throw new ExecutionNotAllowedError(
      "Configured RunStore does not implement claimPendingAction; approval APIs require an approval-capable store",
    );
  }
  return {
    store: store as RunStore & {
      claimPendingAction: NonNullable<RunStore["claimPendingAction"]>;
    },
  };
}

/**
 * Atomically claims a pending tool-action approval, re-authorizes it against
 * the current session/policy/registry, and executes the exact prepared action.
 *
 * Guarantees (§5–6 of the hardening plan):
 * - Concurrent/duplicate approvals execute the tool at most once
 *   (`claimPendingAction` CAS; the loser gets `RunInvalidStateError`).
 * - Wrong session/project/tenant, expired actions, unknown tools, and
 *   drifted prepared input are rejected **before** any side effect.
 * - The execution policy runs again at approval time with the current
 *   security context; a `deny` never executes the tool.
 * - The tool receives a stable `idempotencyKey` (`runId_actionId`) in its
 *   `ToolContext`.
 */
export async function approvePendingAction(
  runtime: AgentRuntime,
  input: ApprovePendingActionInput,
): Promise<ApprovePendingActionResult> {
  const { store } = requireApprovalStore(runtime);

  // 1. Pre-claim validation (fail fast, before any store mutation).
  const preloaded = await store.load(input.runId);
  if (!preloaded) {
    throw new RunInvalidStateError(`Run not found: ${input.runId}`);
  }
  if (preloaded.status !== "waiting") {
    throw new RunInvalidStateError(
      `Run ${input.runId} is not waiting (status: ${preloaded.status})`,
    );
  }
  const prePending = preloaded.state.pending;
  if (
    !prePending ||
    prePending.kind !== "tool_approval" ||
    prePending.actionId !== input.actionId
  ) {
    throw new RunInvalidStateError(
      `Action ${input.actionId} is not the pending action of run ${input.runId}`,
    );
  }
  assertRunBoundToSession(preloaded, input.session);
  const preExpiresAt = Date.parse(prePending.expiresAt);
  if (Number.isNaN(preExpiresAt) || Date.now() > preExpiresAt) {
    throw new RunInvalidStateError(
      `Action ${input.actionId} expired at ${prePending.expiresAt}`,
    );
  }

  // 2. Atomic claim — transitions waiting+actionId → running+claimed.
  const claim = await store.claimPendingAction({
    runId: input.runId,
    actionId: input.actionId,
    expectedStatus: "waiting",
  });
  if (!claim.ok) {
    switch (claim.reason) {
      case "not_found":
        throw new RunInvalidStateError(`Run not found: ${input.runId}`);
      case "not_waiting":
        throw new RunInvalidStateError(
          `Run ${input.runId} is not waiting (already resolved?)`,
        );
      case "action_mismatch":
        throw new RunInvalidStateError(
          `Action ${input.actionId} is not the pending action of run ${input.runId}`,
        );
      case "already_claimed":
        throw new RunInvalidStateError(
          `Action ${input.actionId} was already claimed (duplicate approval)`,
        );
    }
  }

  const run = claim.run;
  const pending = run.state.pending;
  if (!pending || pending.kind !== "tool_approval") {
    throw new RunInvalidStateError(
      `Run ${input.runId} has no tool-approval pending state`,
    );
  }

  // 2. Re-authorization: explicit session binding (project/session/tenant).
  assertRunBoundToSession(run, input.session);

  // 3. Expiry.
  const expiresAt = Date.parse(pending.expiresAt);
  if (Number.isNaN(expiresAt) || Date.now() > expiresAt) {
    throw new RunInvalidStateError(
      `Action ${input.actionId} expired at ${pending.expiresAt}`,
    );
  }

  // 4. Agent definition + deps for the current runtime configuration.
  const agentDef = getAgentDefinition(input.session.projectId, run.agentId);
  if (!agentDef) {
    throw new RunInvalidStateError(
      `Agent definition not found: ${run.agentId} (project ${input.session.projectId})`,
    );
  }
  const deps: EngineDeps = {
    ...buildEngineDeps(agentDef, input.session, runtime, {}),
    startedAtMs: Date.now(),
  };
  const meta = hookRunCtx(deps, run);

  // 5. Tool must still exist and be allowlisted for the agent.
  const tool = resolveToolRegistry(input.session.projectId).get(pending.toolId);
  if (!tool) {
    throw new ExecutionNotAllowedError(`Tool no longer registered: ${pending.toolId}`);
  }

  // 6. Re-prepare and verify the exact prepared action via inputHash — never
  // re-parse raw model output, and refuse on drift (WeakSet-authenticated
  // PreparedToolAction means we must go through prepare()).
  const prepared = await deps.toolRunner.prepare(pending.toolId, pending.preparedInput);
  if (!prepared.ok) {
    throw new ExecutionNotAllowedError(
      `Tool ${pending.toolId} is no longer executable: ${prepared.reason}`,
    );
  }
  if (prepared.ok) {
    const freshHash = stableStringHash(JSON.stringify(prepared.preparedInput));
    if (freshHash !== pending.inputHash) {
      throw new ExecutionNotAllowedError(
        `Prepared input for ${pending.toolId} drifted since proposal; refusing to execute`,
      );
    }
  }

  const executeOnly = input.mode === "execute_only";
  const ctx = { ...toolContext(deps, run), idempotencyKey: claim.idempotencyKey };

  // 7. Re-run the execution policy with the CURRENT security context.
  try {
    await evaluateExecutionPolicy(deps, run, prepared);
  } catch (e) {
    const isDeny = e instanceof ExecutionPolicyError;
    // A second `wait` at approval time still means "not allowed to execute".
    if (!isDeny && !(e instanceof ExecutionWaitError)) throw e;
    // Policy refused even after explicit approval — no side effect. Append a
    // safe observation so the model can react, then continue or stop.
    run.state.pending = null;
    const obs = observationForToolFailure(e);
    appendObservation(run, obs);
    emitToolActionEvent(deps, meta, {
      type: "tool_denied",
      tool: pending.toolId,
      reason: e.message,
      code: e.code,
    });
    deps.hooks?.onObservation?.(obs, meta);
    await emitRun(deps, run, {
      type: "tool_denied",
      tool: pending.toolId,
      code: e.code,
      reason: e instanceof ExecutionPolicyError ? e.message : undefined,
    });
    const deniedRun = await persistFinal(store, run, async () =>
      executeOnly ? run : continueLoop(run, deps),
    );
    return {
      run: deniedRun,
      executed: false,
      deniedCode: e.code,
      idempotencyKey: claim.idempotencyKey,
    };
  }

  // 8. Execute the verified prepared action exactly once.
  emitToolActionEvent(deps, meta, { type: "tool_started", tool: pending.toolId });
  await emitRun(deps, run, { type: "tool_started", tool: pending.toolId });
  const t0 = Date.now();
  let obs: unknown;
  let failed = false;
  try {
    obs = await deps.toolRunner.executePrepared(prepared, ctx);
    emitToolActionEvent(deps, meta, {
      type: "tool_completed",
      tool: pending.toolId,
      output: obs,
    });
    await emitRun(deps, run, {
      type: "tool_completed",
      tool: pending.toolId,
      durationMs: Date.now() - t0,
    });
  } catch (e) {
    failed = true;
    const mapped = observationForToolFailure(e);
    obs = mapped;
    emitToolActionEvent(deps, meta, {
      type: "tool_failed",
      tool: pending.toolId,
      error: mapped.error,
      code: mapped.code,
    });
    await emitRun(deps, run, {
      type: "tool_failed",
      tool: pending.toolId,
      code: mapped.code,
      error: mapped.error,
    });
  }

  // 9. Resolve pending + append observation.
  run.state.pending = null;
  appendObservation(run, obs);
  deps.hooks?.onObservation?.(obs, meta);

  const finalRun = await persistFinal(store, run, () =>
    executeOnly || failed ? Promise.resolve(run) : continueLoop(run, deps),
  );

  return {
    run: finalRun,
    executed: !failed,
    idempotencyKey: claim.idempotencyKey,
  };
}

/**
 * Persists `run` (currently claimed → status "running" in the store) after
 * resolving it via `resolve`. We hold the exclusive claim, so a CAS failure
 * falls back to an unconditional save.
 */
async function persistFinal(
  store: RunStore,
  run: Run,
  resolve: () => Promise<Run> | Run,
): Promise<Run> {
  const final = await resolve();
  const casOk = await store.saveIfStatus(final, "running");
  if (!casOk) await store.save(final);
  return final;
}

/** Continues the engine loop after an observation (no new user message). */
async function continueLoop(run: Run, deps: EngineDeps): Promise<Run> {
  return executeRun(run, { ...deps, startedAtMs: Date.now() });
}

export interface RejectPendingActionInput extends PendingActionRef {
  reason?: string;
}

export interface RejectPendingActionResult {
  run: Run;
}

/**
 * Rejects a pending tool action **without executing it**. Appends a
 * structured observation and continues the engine loop so the model can
 * react to the rejection. CAS-protected from `waiting`; a concurrent
 * approve/reject/cancel wins and this call throws.
 */
export async function rejectPendingAction(
  runtime: AgentRuntime,
  input: RejectPendingActionInput,
): Promise<RejectPendingActionResult> {
  const { store } = requireApprovalStore(runtime);
  const run = await loadWaitingRunWithAction(store, input);
  assertRunBoundToSession(run, input.session);

  const reason = input.reason ?? "Action rejected by host";
  const rejectedToolId =
    run.state.pending && run.state.pending.kind === "tool_approval"
      ? run.state.pending.toolId
      : "unknown";
  if (run.state.pending && run.state.pending.kind === "tool_approval") {
    run.state.pending.rejectionReason = reason;
  }
  run.state.pending = null;
  run.status = "running";

  const obs = { success: false as const, error: reason, code: "ACTION_REJECTED" };
  appendObservation(run, obs);

  // Best-effort events need deps; build them only when hooks/sinks exist.
  const agentDef = getAgentDefinition(input.session.projectId, run.agentId);
  if (agentDef) {
    const deps: EngineDeps = {
      ...buildEngineDeps(agentDef, input.session, runtime, {}),
      startedAtMs: Date.now(),
    };
    emitToolActionEvent(deps, hookRunCtx(deps, run), {
      type: "tool_denied",
      tool: rejectedToolId,
      reason,
      code: "ACTION_REJECTED",
    });
    deps.hooks?.onObservation?.(obs, hookRunCtx(deps, run));
    const final = await continueLoop(run, deps);
    const casOk = await store.saveIfStatus(final, "running");
    if (!casOk) await store.save(final);
    return { run: final };
  }

  const casOk = await store.saveIfStatus(run, "running");
  if (!casOk) throw new RunInvalidStateError(`Run ${run.runId} changed concurrently`);
  return { run };
}

export interface CancelPendingActionInput extends PendingActionRef {
  reason?: string;
}

export interface CancelPendingActionResult {
  run: Run;
}

/**
 * Cancels the pending action and terminally fails the run — the tool never
 * executes. Public event consumers see `run_cancelled` semantics via
 * `failedReason` (`RUN_CANCELLED`), matching the existing cancellation story.
 */
export async function cancelPendingAction(
  runtime: AgentRuntime,
  input: CancelPendingActionInput,
): Promise<CancelPendingActionResult> {
  const { store } = requireApprovalStore(runtime);
  const run = await loadWaitingRunWithAction(store, input);
  assertRunBoundToSession(run, input.session);

  const reason = input.reason ?? "Run cancelled by host";
  if (run.state.pending && run.state.pending.kind === "tool_approval") {
    run.state.pending.rejectionReason = reason;
  }
  run.state.pending = null;
  run.status = "failed";
  run.state.failedReason = `[RUN_CANCELLED] ${reason}`;

  const casOk = await store.saveIfStatus(run, "running");
  if (!casOk) await store.save(run);
  return { run };
}

async function loadWaitingRunWithAction(
  store: RunStore,
  ref: PendingActionRef,
): Promise<Run> {
  const run = await store.load(ref.runId);
  if (!run) throw new RunInvalidStateError(`Run not found: ${ref.runId}`);
  if (run.status !== "waiting") {
    throw new RunInvalidStateError(
      `Run ${ref.runId} is not waiting (status: ${run.status})`,
    );
  }
  const pending = run.state.pending;
  if (!pending || pending.kind !== "tool_approval" || pending.actionId !== ref.actionId) {
    throw new RunInvalidStateError(
      `Action ${ref.actionId} is not the pending action of run ${ref.runId}`,
    );
  }
  return run;
}




