import type { Run, RunStatus } from "../../protocol/types.js";

export interface RunStoreListByAgentAndSessionOptions {
  tenantId?: string;
  status?: RunStatus;
  limit?: number;
  cursor?: string;
  order?: "asc" | "desc";
}

export interface RunStoreListResult {
  runs: Run[];
  nextCursor?: string;
}

/**
 * Persists `Run` objects for `wait`/`resume` across processes.
 *
 * In a single-process app, `InMemoryRunStore` works.
 * In a cluster, use a Redis- or DB-backed implementation so any worker
 * can resume a run started on a different node.
 *
 * See docs/reference/core/16-cluster-deployment.md §3.
 */
export interface RunStore {
  save(run: Run): Promise<void>;
  /**
   * Atomically persist `run` only if the stored document for `run.runId` exists and
   * `status === expectedStatus`. Returns whether the write happened. Used after **`resume`**
   * (and in-process **`wait`** continuations) so two workers cannot both overwrite a **`waiting`** run.
   */
  saveIfStatus(run: Run, expectedStatus: RunStatus): Promise<boolean>;
  load(runId: string): Promise<Run | null>;
  delete(runId: string): Promise<void>;
  listByAgent(agentId: string, status?: RunStatus): Promise<Run[]>;
  listByAgentAndSession(
    projectId: string,
    agentId: string,
    sessionId: string,
    opts?: RunStoreListByAgentAndSessionOptions,
  ): Promise<RunStoreListResult>;
  /**
   * Atomically claim a pending tool-action approval.
   *
   * Transitions a run in `waiting` state (with `state.pending.kind === "tool_approval"`
   * and matching `actionId`) to a claimed state, preventing concurrent approval from
   * executing the same tool twice.
   *
   * - The run must exist, be in `waiting` status, and the pending action must match `actionId`.
   * - If already claimed (`pending.claimed === true`), returns `{ ok: false, reason: "already_claimed" }`.
   * - On success, returns the run with `status === "running"` and `pending.claimed === true`,
   *   along with a stable `idempotencyKey` derived from `runId + actionId`.
   *
   * This is optional on the interface; stores that do not implement it throw
   * `ExecutionNotAllowedError` at call time.
   */
  claimPendingAction?(input: {
    runId: string;
    actionId: string;
    expectedStatus: "waiting";
  }): Promise<
    | { ok: true; run: Run; idempotencyKey: string }
    | { ok: false; reason: "not_found" | "not_waiting" | "action_mismatch" | "already_claimed" }
  >;
}
