/** "cancelled" is not a distinct status — cancellation sets "failed" with RunCancelledError. */
export type RunStatus = "running" | "waiting" | "completed" | "failed";

export type Step =
  | { type: "thought"; content: string }
  | { type: "action"; tool: string; input: unknown }
  | { type: "wait"; reason: string; details?: unknown }
  | { type: "result"; content: string };

export interface ProtocolMessage {
  type: "thought" | "action" | "observation" | "wait" | "result";
  content: unknown;
  meta: {
    ts: string;
    source: "llm" | "engine" | "tool";
  };
}

/**
 * Metadata captured from the agent definition / execution context at the moment
 * a pending action was prepared. Used at approval time to detect whether the
 * agent's policy or tool set changed since the action was first proposed.
 */
export interface PreparedActionMeta {
  /** Stable identifier for the tool at proposal time. */
  toolName: string;
  /** Agent id captured at proposal time. */
  agentId: string;
  /**
   * Sorted, joined list of `securityContext.scopes` present when the action
   * was first proposed. At approval time the runtime re-derives scopes from
   * the current security context and compares — a mismatch means the
   * principal's scopes were revoked after the action was queued.
   */
  scopesAtProposal: string;
  /** ISO timestamp when the action was prepared. */
  preparedAt: string;
  /** Iteration counter value at the time of preparation. */
  iterationAtPreparation: number;
}

/**
 * A tool action awaiting explicit approval before execution.
 *
 * Lifecycle:
 *   `waiting` + `pending(kind: "tool_approval", actionId)`
 *     → `running` + `pending.claimed = true` (via `claimPendingAction`)
 *
 * The `preparedInput` is the canonicalized value produced by
 * `ToolAdapter.prepareInput` (when present) or the raw model input — it is
 * never re-read from raw LLM output at approval time.
 */
export interface PendingToolApproval {
  kind: "tool_approval";
  actionId: string;
  toolId: string;
  toolDescription?: string;
  /** Canonicalized input — safe to pass to `tool.executePrepared` without re-preparation. */
  preparedInput: unknown;
  /**
   * Deterministic hash of `JSON.stringify(preparedInput)` at proposal time.
   * Approval recomputes this hash after a fresh `prepare()` and refuses to
   * execute on mismatch — guaranteeing the exact prepared action runs even
   * when the stored input is an opaque host-managed reference.
   */
  inputHash: string;
  /** Policy-supplied reason for requiring approval. */
  reason?: string;
  details?: unknown;
  /** Snapshot of agent/security context captured at proposal time for re-authorization. */
  preparedBy: PreparedActionMeta;
  /** ISO timestamp when the pending action was created. */
  createdAt: string;
  /** ISO timestamp; approval is rejected after this time. */
  expiresAt: string;
  /** Number of claim attempts for this action (0 = fresh). */
  attempts: number;
  /** Set to `true` by a successful atomic `claimPendingAction`. */
  claimed?: boolean;
  /** ISO timestamp of the claim, if any. */
  claimedAt?: string;
  /** Opaque token identifying the claimant for audit. */
  claimant?: string;
  /** If the action was rejected/cancelled, records the reason. */
  rejectionReason?: string;
}

export type PendingState =
  | { kind: "user_input"; reason: string; details?: unknown }
  | PendingToolApproval
  | null;

export interface Run {
  runId: string;
  agentId: string;
  sessionId?: string;
  /** Optional sub-scope inside `projectId`; when set, reads/resumes must present the same tenant. */
  tenantId?: string;
  /**
   * Project that owns this run — set when created via {@link createRun} / {@link Agent.run}.
   * Used by HTTP and store indexes to reject cross-project reads.
   */
  projectId?: string;
  status: RunStatus;
  history: ProtocolMessage[];
  state: {
    iteration: number;
    pending: PendingState;
    parseAttempts?: number;
    /** Latest user text for this run (first turn). */
    userInput?: string;
    /**
     * Text from each **`resume`** after a **`wait`** (HTTP or in-process), in order — not duplicated in **`history`**.
     */
    resumeInputs?: string[];
    /**
     * Text from each **`continue`** (new user turn on a **`completed`** run), in order — not duplicated in **`history`**.
     */
    continueInputs?: string[];
    /**
     * Last engine error message when **`status`** was persisted as **`failed`** (set in {@link RunBuilder} catch).
     */
    failedReason?: string;
    [key: string]: unknown;
  };
}

export interface RunEnvelope {
  id: string;
  agentId: string;
  sessionId?: string;
  messages: ProtocolMessage[];
  state: Record<string, unknown>;
  tools: string[];
  status: RunStatus;
}
