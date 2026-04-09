/**
 * Stable ids for tools registered by {@link registerRagToolsAndSkills}.
 */
export const RAG_SYSTEM_TOOL_IDS = [
  "system_list_rag_sources",
  "system_ingest_rag_source",
  "system_file_read",
  "system_file_ingest",
  "system_file_list",
] as const;

export type RagSystemToolId = (typeof RAG_SYSTEM_TOOL_IDS)[number];

const ragSystemToolIdSet = new Set<string>(RAG_SYSTEM_TOOL_IDS);

/** True if `id` is a RAG package `system_*` tool id. */
export function isRagSystemToolId(id: string): boolean {
  return ragSystemToolIdSet.has(id);
}
