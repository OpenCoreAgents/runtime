import { fileURLToPath } from "node:url";
import path from "node:path";
import type { RagSourceDefinition } from "@agent-runtime/rag";

const here = path.dirname(fileURLToPath(import.meta.url));

export const DEMO_FILE_READ_ROOT = path.join(here, "..", "data");

export const SUPPORT_RAG_SOURCES: RagSourceDefinition[] = [
  {
    id: "support-handbook",
    description:
      "Internal support handbook: refunds, international orders, escalation, and contact reference.",
    source: "support-handbook.md",
  },
];

export const SUPPORT_CATALOG_ID = "support-handbook";
