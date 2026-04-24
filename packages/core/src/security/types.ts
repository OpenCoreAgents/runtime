export interface SessionOptions {
  id: string;
  projectId: string;
  tenantId?: string;
  endUserId?: string;
  /**
   * Arbitrary host-resolved context (JWT claims, form intake, BFF headers, etc.). Copied to
   * {@link import("../adapters/tool/ToolAdapter.js").ToolContext.sessionContext} for every tool call.
   * Prefer plain JSON-serializable values so workers/queues can persist the same shape.
   */
  sessionContext?: Readonly<Record<string, unknown>>;
  /** When set, runs and resumes are rejected after this instant (Unix ms, same as `Date.now()`). */
  expiresAtMs?: number;
  /**
   * Base directory for `system_file_read` / `system_file_ingest` local paths (relative paths resolve under here).
   * When set, overrides `fileReadRoot` from `AgentRuntime` / `EngineConfig`. HTTP(S) sources ignore this.
   */
  fileReadRoot?: string;
  /**
   * Explicit opt-in to read local files outside `fileReadRoot` or via absolute paths.
   * When true, local resolution behaves like unconstrained `path.resolve` + `readFile`.
   */
  allowFileReadOutsideRoot?: boolean;
  /**
   * Explicit opt-in for `system_file_read` / `system_file_ingest` when `source` is an http(s) URL
   * (mitigates SSRF from model-controlled URLs).
   */
  allowHttpFileSources?: boolean;
  /**
   * When non-empty, http(s) URLs are only allowed when `URL.hostname` matches an entry
   * (case-insensitive, exact host only).
   */
  httpFileSourceHostsAllowlist?: string[];
}

export interface SecurityContext {
  principalId: string;
  kind: "user" | "service" | "end_user" | "internal";
  organizationId: string;
  projectId: string;
  endUserId?: string;
  roles: string[];
  scopes: string[];
}
