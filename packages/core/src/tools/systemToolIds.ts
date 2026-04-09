/**
 * Stable ids for tools registered by {@link AgentRuntime} bootstrap (`registerBuiltinToolHandlers`,
 * optional `registerVectorToolHandlers`, `registerSendMessageToolHandler`).
 * Vector handlers exist only when `embeddingAdapter` + `vectorAdapter` are set; messaging only when `messageBus` is set.
 */
export const CORE_SYSTEM_TOOL_IDS = [
  "system_save_memory",
  "system_get_memory",
  "system_vector_search",
  "system_vector_upsert",
  "system_vector_delete",
  "system_send_message",
] as const;

export type CoreSystemToolId = (typeof CORE_SYSTEM_TOOL_IDS)[number];

const coreSystemToolIdSet = new Set<string>(CORE_SYSTEM_TOOL_IDS);

/** True if `id` is a core-engine `system_*` tool id (independent of whether a handler is registered this run). */
export function isCoreSystemToolId(id: string): boolean {
  return coreSystemToolIdSet.has(id);
}
