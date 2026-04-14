/**
 * Payload for queue workers (e.g. BullMQ) that drive the same entry points as the SDK:
 * {@link Agent.run} and {@link Agent.resume}. Use with {@link AgentRuntime.dispatch} or {@link dispatchEngineJob}.
 */
export type EngineResumeInput = { type: string; content: string };

export type EngineRunJobPayload = {
  kind: "run";
  projectId: string;
  agentId: string;
  sessionId: string;
  /**
   * When set, the engine uses this id for the new {@link Run} (queue / Planner correlation).
   * Must be unique across runs your {@link RunStore} will see.
   */
  runId?: string;
  /** When set, forwarded to {@link Session} for B2B2C memory (`longTerm` / `vectorMemory` scoping). */
  endUserId?: string;
  /** Forwarded to {@link Session.sessionContext} (e.g. claims, locale, support email). */
  sessionContext?: Readonly<Record<string, unknown>>;
  /** When set, {@link AgentRuntime.dispatch} / {@link dispatchEngineJob} throws if `Date.now()` exceeds this (Unix ms). */
  expiresAtMs?: number;
  /** Forwarded to `Session` for sandboxed `system_file_read` / `system_file_ingest` local paths. */
  fileReadRoot?: string;
  allowFileReadOutsideRoot?: boolean;
  allowHttpFileSources?: boolean;
  httpFileSourceHostsAllowlist?: string[];
  userInput: string;
};

export type EngineResumeJobPayload = {
  kind: "resume";
  projectId: string;
  agentId: string;
  sessionId: string;
  endUserId?: string;
  sessionContext?: Readonly<Record<string, unknown>>;
  expiresAtMs?: number;
  fileReadRoot?: string;
  allowFileReadOutsideRoot?: boolean;
  allowHttpFileSources?: boolean;
  httpFileSourceHostsAllowlist?: string[];
  runId: string;
  resumeInput: EngineResumeInput;
};

/**
 * Append a new user turn to an existing **`completed`** run (same **`runId`**, full **`history`** kept).
 * Not “chat” in the product sense — a deterministic engine primitive for multi-turn continuity.
 */
export type EngineContinueJobPayload = {
  kind: "continue";
  projectId: string;
  agentId: string;
  sessionId: string;
  endUserId?: string;
  sessionContext?: Readonly<Record<string, unknown>>;
  expiresAtMs?: number;
  fileReadRoot?: string;
  allowFileReadOutsideRoot?: boolean;
  allowHttpFileSources?: boolean;
  httpFileSourceHostsAllowlist?: string[];
  runId: string;
  userInput: string;
};

export type EngineJobPayload =
  | EngineRunJobPayload
  | EngineResumeJobPayload
  | EngineContinueJobPayload;
