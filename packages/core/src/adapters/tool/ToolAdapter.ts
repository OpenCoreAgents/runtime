import type { MemoryAdapter } from "../memory/MemoryAdapter.js";
import type { SecurityContext } from "../../security/types.js";
import type { MessageBus } from "../../bus/MessageBus.js";
import type { SendMessageTargetPolicy } from "../../tools/sendMessagePolicy.js";
import type { RagFileSourceEntry } from "../../ragCatalogTypes.js";

export interface ToolContext {
  projectId: string;
  tenantId?: string;
  agentId: string;
  runId: string;
  sessionId: string;
  endUserId?: string;
  /** Copied from {@link Session.sessionContext}; treat as read-only in tool handlers. */
  sessionContext?: Readonly<Record<string, unknown>>;
  memoryAdapter: MemoryAdapter;
  securityContext: SecurityContext;
  /** Effective sandbox root: session overrides `AgentRuntime` config (see {@link buildEngineDeps}). */
  fileReadRoot?: string;
  /** Copied from {@link Session.allowFileReadOutsideRoot}. */
  allowFileReadOutsideRoot?: boolean;
  /** Copied from {@link Session.allowHttpFileSources}. */
  allowHttpFileSources?: boolean;
  /** Copied from {@link Session.httpFileSourceHostsAllowlist}. */
  httpFileSourceHostsAllowlist?: string[];
  /** Set when {@link AgentRuntime} provides `messageBus` (e.g. for `system_send_message`). */
  messageBus?: MessageBus;
  /** From {@link AgentRuntime} `sendMessageTargetPolicy` when set. */
  sendMessageTargetPolicy?: SendMessageTargetPolicy;
  /** Per-project RAG catalog when registered for `session.projectId` (`@opencoreagents/rag` / `AgentRuntime`). */
  ragFileCatalog?: ReadonlyArray<RagFileSourceEntry>;
  /**
   * Stable key (`runId_actionId`) present when the execution came from an
   * approved pending action. Tools with side effects should use it to make
   * retries/duplicate approvals idempotent downstream.
   */
  idempotencyKey?: string;
}

export type ToolValidationResult =
  | boolean
  | {
      ok: boolean;
      reason?: string;
    };

export type ToolInputPreparation =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

export interface ToolAdapter {
  name: string;
  description?: string;
  /**
   * Canonicalizes raw model input before validation, policy, approval, hashing, events,
   * and execution. When present, the returned `value` is the only input passed to
   * {@link execute}. Tools without `prepareInput` keep using {@link validate}.
   */
  prepareInput?(rawInput: unknown): ToolInputPreparation | Promise<ToolInputPreparation>;
  validate?(rawInput: unknown): ToolValidationResult;
  execute(input: unknown, context: ToolContext): Promise<unknown>;
}

export interface ObservationContent {
  success: boolean;
  data?: unknown;
  error?: string;
}
