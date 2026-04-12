import type { SkillDefinition } from "@opencoreagents/core";

export const ragSkill: SkillDefinition = {
  id: "rag",
  scope: "global",
  tools: [
    "system_list_rag_sources",
    "system_ingest_rag_source",
    "system_vector_search",
    "system_vector_upsert",
    "system_vector_delete",
    "system_file_read",
    "system_file_ingest",
    "system_file_list",
  ],
  description:
    "Retrieval-Augmented Generation: list and ingest preregistered sources, search the knowledge base, " +
    "and manage stored fragments.",
};

export const ragReaderSkill: SkillDefinition = {
  id: "rag-reader",
  scope: "global",
  tools: ["system_list_rag_sources", "system_vector_search"],
  description:
    "List registered RAG sources (id + description) and search the knowledge base for context.",
};
