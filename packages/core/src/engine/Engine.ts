import type { EngineDeps, EngineHookRunContext, EngineHooks } from "./types.js";
import type { Run } from "../protocol/types.js";
import type { Step } from "../protocol/types.js";
import type { ToolContext } from "../adapters/tool/ToolAdapter.js";
import type { PreparedToolAction } from "../tools/ToolRunner.js";
import { normalizeLlmStepContent } from "./normalizeLlmStepContent.js";
import { parseStep } from "./parseStep.js";
import { observationForToolFailure } from "./toolFailureObservation.js";
import {
  ExecutionPolicyError,
  ExecutionWaitError,
  MaxIterationsError,
  RunCancelledError,
  RunTimeoutError,
  StepSchemaError,
} from "../errors/index.js";
import { createRandomUuid } from "#runtime-environment";
import type { ExecutionPolicyInput } from "./executionPolicy.js";
import type {
  ToolActionEvent,
  ToolActionEventContext,
  ToolActionEventType,
} from "./toolActionEvents.js";
import { buildToolActionEvent } from "./toolActionEvents.js";
import { emitPublicRunEvent } from "./publicEvents.js";
import { EngineError } from "../errors/index.js";

/** Runtime identity + envelope assembly for public run events. */
export async function emitRun(
  deps: EngineDeps,
  run: Run,
  event: import("./publicEvents.js").PublicRunEventPayload,
): Promise<void> {
  await emitPublicRunEvent(
    deps,
    {
      runId: run.runId,
      agentId: run.agentId,
      sessionId: deps.session.id || undefined,
      projectId: deps.session.projectId || undefined,
      tenantId: deps.session.tenantId,
    },
    event,
  );
}

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Emits a minimal tool-action lifecycle event to the runtime-configured sink.
 * `input`/`output` are dropped unless `toolEventsIncludeInputOutput` opts in.
 */
export function emitToolActionEvent(
  deps: EngineDeps,
  meta: EngineHookRunContext,
  event: {
    type: ToolActionEventType;
    tool: string;
    input?: unknown;
    output?: unknown;
    reason?: string;
    code?: string;
    error?: string;
  },
): void {
  if (!deps.toolEventSink) return;
  const base: ToolActionEventContext = {
    ...meta,
    ts: isoNow(),
    tool: event.tool,
  };
  const { input, output, ...rest } = event;
  const built = buildToolActionEvent(
    base,
    { ...rest, input, output },
    {
      includeInput: Boolean(deps.toolEventsIncludeInputOutput),
      includeOutput: Boolean(deps.toolEventsIncludeInputOutput),
    },
  );
  deps.toolEventSink(built as ToolActionEvent);
}

function appendThought(run: Run, content: string): void {
  run.history.push({
    type: "thought",
    content,
    meta: { ts: isoNow(), source: "llm" },
  });
}

function appendAction(run: Run, step: Extract<Step, { type: "action" }>): void {
  run.history.push({
    type: "action",
    content: { tool: step.tool, input: step.input },
    meta: { ts: isoNow(), source: "llm" },
  });
}

export function appendObservation(run: Run, content: unknown): void {
  run.history.push({
    type: "observation",
    content,
    meta: { ts: isoNow(), source: "tool" },
  });
}

function appendWait(run: Run, step: Extract<Step, { type: "wait" }>): void {
  run.history.push({
    type: "wait",
    content: { reason: step.reason, details: step.details },
    meta: { ts: isoNow(), source: "llm" },
  });
}

function appendResult(run: Run, content: string): void {
  run.history.push({
    type: "result",
    content,
    meta: { ts: isoNow(), source: "llm" },
  });
}

export function toolContext(deps: EngineDeps, run: Run): ToolContext {
  const ctx: ToolContext & Record<string, unknown> = {
    projectId: deps.session.projectId,
    tenantId: deps.session.tenantId,
    agentId: deps.agent.id,
    runId: run.runId,
    sessionId: deps.session.id,
    endUserId: deps.session.endUserId,
    sessionContext: deps.session.sessionContext,
    memoryAdapter: deps.memoryAdapter,
    securityContext: deps.securityContext,
    fileReadRoot: deps.fileReadRoot ?? deps.session.fileReadRoot,
    allowFileReadOutsideRoot: deps.session.allowFileReadOutsideRoot,
    allowHttpFileSources: deps.session.allowHttpFileSources,
    httpFileSourceHostsAllowlist: deps.session.httpFileSourceHostsAllowlist,
  };
  if (deps.embeddingAdapter) ctx.embeddingAdapter = deps.embeddingAdapter;
  if (deps.vectorAdapter) ctx.vectorAdapter = deps.vectorAdapter;
  if (deps.messageBus) ctx.messageBus = deps.messageBus;
  if (deps.sendMessageTargetPolicy)
    ctx.sendMessageTargetPolicy = deps.sendMessageTargetPolicy;
  if (deps.ragFileCatalog !== undefined) ctx.ragFileCatalog = deps.ragFileCatalog;
  return ctx;
}

export function hookRunCtx(deps: EngineDeps, run: Run): EngineHookRunContext {
  return {
    runId: run.runId,
    agentId: deps.agent.id,
    projectId: run.projectId ?? deps.session.projectId,
    sessionId: run.sessionId ?? deps.session.id,
  };
}

export async function evaluateExecutionPolicy(
  deps: EngineDeps,
  run: Run,
  prepared: Extract<PreparedToolAction, { ok: true }>,
): Promise<void> {
  if (!deps.executionPolicy) return;
  const input: ExecutionPolicyInput = {
    agent: deps.agent,
    session: deps.session,
    run,
    tool: prepared.tool,
    preparedInput: prepared.preparedInput,
    securityContext: deps.securityContext,
    hostContext: deps.hostContext,
  };
    const decision = await deps.executionPolicy(input);
  if (decision.decision === "deny") {
    throw new ExecutionPolicyError(decision.reason, decision.details);
  }
  if (decision.decision === "wait") {
    throw new ExecutionWaitError(
      "Execution waiting for approval",
      decision.reason,
      decision.details,
      decision.ttlMs,
    );
  }
}

/**
 * Builds a `PendingToolApproval` from an `ExecutionWaitError` and the
 * prepared action that triggered the wait. The `actionId` is stable,
 * derived from `runId` + a deterministic hash of the prepared input.
 */
function buildPendingToolApproval(
  deps: EngineDeps,
  run: Run,
  prepared: Extract<PreparedToolAction, { ok: true }>,
  err: ExecutionWaitError,
): import("../protocol/types.js").PendingToolApproval {
  const now = Date.now();
  const defaultTtl = 300_000; // 5 minutes
  const ttlMs = typeof err.ttlMs === "number" && err.ttlMs > 0 ? err.ttlMs : defaultTtl;

  // Stable action id: runId + deterministic hash of preparedInput.
  const inputHash = stableStringHash(JSON.stringify(prepared.preparedInput));
  const actionId = `${run.runId}_${inputHash}`;
  const nowIso = isoNow();

  const scopes = (deps.securityContext.scopes ?? []).slice().sort();

  return {
    kind: "tool_approval",
    actionId,
    toolId: prepared.toolName,
    preparedInput: prepared.preparedInput,
    inputHash,
    reason: err.reason,
    details: err.details,
    preparedBy: {
      toolName: prepared.toolName,
      agentId: deps.agent.id,
      scopesAtProposal: scopes.join(","),
      preparedAt: nowIso,
      iterationAtPreparation: run.state.iteration,
    },
    createdAt: nowIso,
    expiresAt: new Date(now + ttlMs).toISOString(),
    attempts: 0,
  };
}

/**
 * Deterministic FNV-1a string hash — stable across Node.js and browsers.
 *
 * NOTE: this is used as a tamper-evidence / accidental-drift check, not as
 * a cryptographically secure integrity guarantee. The primary guarantee that
 * the approved prepared input is the same one proposed by the model comes from
 * the WeakSet-authenticated PreparedToolAction and the registry/allowlist
 * checks in ToolRunner.executePrepared. If you need adversarial integrity,
 * replace this with SHA-256 (e.g. `crypto.subtle.digest`).
 */
export function stableStringHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  }
  return h.toString(36);
}

/**
 * Creates a new {@link Run} for {@link executeRun}. Prefer {@link Agent.run} / {@link RunBuilder};
 * with {@link buildEngineDeps} for the static part of {@link EngineDeps} when wiring queue workers or tests.
 */
export function createRun(
  agentId: string,
  sessionId: string | undefined,
  userInput: string,
  projectId?: string,
  /** When set, used instead of a random id (e.g. Planner sub-agent correlation). */
  explicitRunId?: string,
  tenantId?: string,
): Run {
  const run: Run = {
    runId:
      typeof explicitRunId === "string" && explicitRunId.trim() !== ""
        ? explicitRunId.trim()
        : createRandomUuid(),
    agentId,
    sessionId,
    status: "running",
    history: [],
    state: {
      iteration: 0,
      pending: null,
      parseAttempts: 0,
      userInput,
    },
  };
  if (projectId !== undefined && projectId !== "") {
    run.projectId = projectId;
  }
  if (tenantId !== undefined && tenantId !== "") {
    run.tenantId = tenantId;
  }
  return run;
}

/**
 * Runs the thought → action → observation loop until `result`, `wait`, failure, or max iterations.
 * Prefer {@link buildEngineDeps} for the static part of {@link EngineDeps}, then add
 * `startedAtMs` and optional `resumeMessages`. Adapters come from {@link AgentRuntime}.
 */
const RESUME_USER_PREFIX = /^\[resume:[^\]]+\]\s*([\s\S]*)$/;
const CONTINUE_USER_PREFIX = /^\[continue:user\]\s*([\s\S]*)$/;

function appendResumeInputsFromMessages(
  run: Run,
  msgs: Array<{ role: string; content: string }> | undefined,
): void {
  if (!msgs?.length) return;
  const raw = msgs[0]?.content;
  if (typeof raw !== "string") return;
  const m = RESUME_USER_PREFIX.exec(raw);
  if (!m) return;
  const text = m[1]?.trimEnd() ?? "";
  const list = run.state.resumeInputs ?? [];
  list.push(text);
  run.state.resumeInputs = list;
}

function appendContinueInputsFromMessages(
  run: Run,
  msgs: Array<{ role: string; content: string }> | undefined,
): void {
  if (!msgs?.length) return;
  const raw = msgs[0]?.content;
  if (typeof raw !== "string") return;
  const m = CONTINUE_USER_PREFIX.exec(raw);
  if (!m) return;
  const text = m[1]?.trimEnd() ?? "";
  const list = run.state.continueInputs ?? [];
  list.push(text);
  run.state.continueInputs = list;
}

export async function executeRun(run: Run, deps: EngineDeps): Promise<Run> {
  run.status = "running";
  appendResumeInputsFromMessages(run, deps.resumeMessages);
  appendContinueInputsFromMessages(run, deps.resumeMessages);
  const { limits } = deps;
  let firstBuild = true;

  const isResume = Boolean(deps.resumeMessages?.length);
  await emitRun(deps, run, isResume ? { type: "run_resumed" } : { type: "run_started" });

  try {

  while (run.state.iteration < limits.maxIterations) {
    if (Date.now() - deps.startedAtMs > limits.runTimeoutMs) {
      run.status = "failed";
      throw new RunTimeoutError();
    }
    if (deps.signal?.aborted) {
      run.status = "failed";
      throw new RunCancelledError();
    }

    const recoveryMessages = run.state.parseRecovery as
      | Array<{ role: "user" | "assistant"; content: string }>
      | undefined;
    delete run.state.parseRecovery;

    const built = await deps.contextBuilder.build({
      agent: deps.agent,
      run,
      session: deps.session,
      memoryAdapter: deps.memoryAdapter,
      securityContext: deps.securityContext,
      toolRegistry: deps.toolRegistry,
      effectiveToolAllowlist: deps.effectiveToolAllowlist,
      visibilityPolicy: deps.visibilityPolicy,
      hostContext: deps.hostContext,
      resumeMessages:
        firstBuild && deps.resumeMessages?.length ? deps.resumeMessages : undefined,
      recoveryMessages,
    });
    firstBuild = false;

    const llmResponseRaw = await deps.llmAdapter.generate({
      provider: deps.agent.llm!.provider,
      model: deps.agent.llm!.model,
      messages: built.messages,
      tools: built.tools,
      toolChoice: built.toolChoice,
      responseFormat: built.responseFormat,
      temperature:
        typeof deps.agent.llm?.temperature === "number"
          ? deps.agent.llm.temperature
          : 0.2,
      signal: deps.signal,
    });

    const hooks = deps.hooks as EngineHooks | undefined;
    const meta = hookRunCtx(deps, run);
    hooks?.onLLMResponse?.(llmResponseRaw, meta);

    const llmResponse = normalizeLlmStepContent(llmResponseRaw);

    let step: Step;
    try {
      step = parseStep(llmResponse.content);
      run.state.parseAttempts = 0;
      hooks?.onLLMAfterParse?.(llmResponse, meta, "parsed");
    } catch {
      const pa = (run.state.parseAttempts ?? 0) + 1;
      run.state.parseAttempts = pa;
      if (pa <= limits.maxParseRecovery) {
        hooks?.onLLMAfterParse?.(llmResponse, meta, "parse_failed_recoverable");
        run.state.parseRecovery = [
          {
            role: "assistant",
            content: llmResponse.content.slice(0, 4000),
          },
          {
            role: "user",
            content:
              "Your last output was not valid JSON. Return only one JSON object with type and required fields.",
          },
        ];
        continue;
      }
      hooks?.onLLMAfterParse?.(llmResponse, meta, "parse_failed_fatal");
      run.status = "failed";
      throw new StepSchemaError("Exceeded parse recovery attempts");
    }

    switch (step.type) {
      case "thought": {
        appendThought(run, step.content);
        hooks?.onThought?.(step, meta);
        break;
      }
      case "action": {
        appendAction(run, step);
        hooks?.onAction?.(step, meta);
        let obs: unknown;
        // Prepared before the try so the approval path in `catch` can access
        // the exact prepared action that triggered the policy wait.
        const prepared = await deps.toolRunner.prepare(step.tool, step.input);
        try {
          if (prepared.ok) {
            emitToolActionEvent(deps, meta, {
              type: "tool_proposed",
              tool: prepared.toolName,
              input: prepared.preparedInput,
            });
            await emitRun(deps, run, { type: "tool_proposed", tool: prepared.toolName });
            await evaluateExecutionPolicy(deps, run, prepared);
            emitToolActionEvent(deps, meta, {
              type: "tool_started",
              tool: prepared.toolName,
            });
            await emitRun(deps, run, { type: "tool_started", tool: prepared.toolName });
            const t0 = Date.now();
            obs = await deps.toolRunner.executePrepared(prepared, toolContext(deps, run));
            emitToolActionEvent(deps, meta, {
              type: "tool_completed",
              tool: prepared.toolName,
              output: obs,
            });
            await emitRun(deps, run, {
              type: "tool_completed",
              tool: prepared.toolName,
              durationMs: Date.now() - t0,
            });
          } else {
            // Unknown / disallowed / validation / preparation failure — executePrepared
            // throws the matching error, caught below and reported as `tool_failed`.
            obs = await deps.toolRunner.executePrepared(prepared, toolContext(deps, run));
          }
        } catch (e) {
          if (e instanceof ExecutionWaitError && prepared.ok) {
            // Policy requested approval — set pending state and return to caller.
            const pending = buildPendingToolApproval(deps, run, prepared, e);
            run.status = "waiting";
            run.state.pending = pending;
            emitToolActionEvent(deps, meta, {
              type: "tool_awaiting_approval",
              tool: prepared.toolName,
              reason: e.reason ?? "approval_required",
            });
            await emitRun(deps, run, {
              type: "tool_awaiting_approval",
              tool: prepared.toolName,
              actionId: pending.actionId,
              reason: e.reason,
              expiresAt: pending.expiresAt,
            });
            await emitRun(deps, run, {
              type: "run_waiting",
              pendingKind: "tool_approval",
              reason: pending.reason,
              actionId: pending.actionId,
            });
            return run;
          }
          if (e instanceof ExecutionPolicyError) {
            emitToolActionEvent(deps, meta, {
              type: "tool_denied",
              tool: step.tool,
              reason: e.message,
              code: e.code,
            });
            await emitRun(deps, run, {
              type: "tool_denied",
              tool: step.tool,
              code: e.code,
              reason: e.message,
            });
          } else {
            const mapped = observationForToolFailure(e);
            emitToolActionEvent(deps, meta, {
              type: "tool_failed",
              tool: step.tool,
              error: mapped.error,
              code: mapped.code,
            });
            await emitRun(deps, run, {
              type: "tool_failed",
              tool: step.tool,
              code: mapped.code,
              error: mapped.error,
            });
          }
          obs = observationForToolFailure(e);
        }
        appendObservation(run, obs);
        hooks?.onObservation?.(obs, meta);
        break;
      }
  case "wait": {
        appendWait(run, step);
        run.status = "waiting";
        run.state.pending = {
          kind: "user_input",
          reason: step.reason,
          details: step.details,
        };
        hooks?.onWait?.(step, meta);
        await emitRun(deps, run, {
          type: "run_waiting",
          pendingKind: "user_input",
          reason: step.reason,
        });
        return run;
      }
      case "result": {
        appendResult(run, step.content);
        run.status = "completed";
        await emitRun(deps, run, { type: "run_completed" });
        return run;
      }
      default: {
        const _exhaustive: never = step;
        void _exhaustive;
      }
    }

    run.state.iteration++;
  }

  run.status = "failed";
  throw new MaxIterationsError();
  } catch (e) {
    const cancelled =
      e instanceof RunCancelledError || deps.signal?.aborted === true;
    if (cancelled) {
      await emitRun(deps, run, {
        type: "run_cancelled",
        reason: e instanceof Error ? e.message : undefined,
      });
    } else {
      await emitRun(deps, run, {
        type: "run_failed",
        code: e instanceof EngineError ? e.code : undefined,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    throw e;
  }
}
