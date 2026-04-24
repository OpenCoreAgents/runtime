---
name: opencoreagents-rag-dynamic
description: Use @opencoreagents/rag (catalog, ingest, file tools, skills) and related core hooks (registerRagCatalog on AgentRuntime).
---

# OpenCore Agents — RAG (`@opencoreagents/rag`)

> **Bundled docs:** **`docs/`** next to this file (`docs/reference/core/...`); **`packages/rag/README.md`** lives under the sibling **`packages/`** folder. API: `skillDocsDirectory("opencoreagents-rag-dynamic")`.

Use when the user needs **file ingestion**, **vector search**, **per-project catalogs**, or **skills** `rag` / `rag-reader`.

`@opencoreagents/rag` ships from the public runtime repo [OpenCoreAgents/runtime](https://github.com/OpenCoreAgents/runtime).

## Registration

1. Call **`registerRagToolsAndSkills()`** from `@opencoreagents/rag` once at startup (after `AgentRuntime` exists if you use runtime-bound catalog APIs).
2. Prefer **`registerRagCatalog(runtime, projectId, entries)`** (or equivalent) so **`system_list_rag_sources`** / **`system_ingest_rag_source`** work with **ids**.

## Fragments from `examples/rag`

Catalog entries are **`RagSourceDefinition`**: stable **`id`**, **`description`** (what the list tool shows), and **`source`** (path relative to **`fileReadRoot`** or an allowed URL — see bundled `docs/reference/core/18-rag-pipeline.md`).

```typescript
// Adapted from examples/rag/src/fileSources.ts
import type { RagSourceDefinition } from "@opencoreagents/rag";

export const DEMO_RAG_SOURCES: RagSourceDefinition[] = [
  {
    id: "demo-handbook",
    description:
      "Intro markdown for this example: RAG, catalog ingest, system_vector_search, and production adapters.",
    source: "sample.md",
  },
];
```

Wire **`embeddingAdapter`**, **`vectorAdapter`**, **`fileReadRoot`**, register tools, then catalog, then an agent with **`skills: ["rag"]`**:

```typescript
// Adapted from examples/rag/src/main.ts
import {
  Agent,
  AgentRuntime,
  Session,
  InMemoryMemoryAdapter,
} from "@opencoreagents/core";
import { registerRagCatalog, registerRagToolsAndSkills } from "@opencoreagents/rag";

const runtime = new AgentRuntime({
  llmAdapter: /* your LLM */,
  memoryAdapter: new InMemoryMemoryAdapter(),
  embeddingAdapter: createDemoEmbeddingAdapter(),
  vectorAdapter: createDemoVectorAdapter(),
  fileReadRoot: DEMO_FILE_READ_ROOT,
  maxIterations: 15,
});

await registerRagToolsAndSkills();
registerRagCatalog(runtime, "demo-project", DEMO_RAG_SOURCES);

await Agent.define({
  id: "rag-demo-agent",
  projectId: "demo-project",
  systemPrompt:
    "You are a retrieval assistant. Use system_list_rag_sources / system_ingest_rag_source / system_vector_search as needed.",
  tools: [],
  skills: ["rag"],
  llm: { provider: "openai", model: "gpt-4o-mini" },
  security: { roles: ["agent", "admin", "operator"] },
});

const agent = await Agent.load(
  "rag-demo-agent",
  runtime,
  { session: new Session({ id: "demo-session-rag", projectId: "demo-project" }) },
);
await agent.run("Use the knowledge base to summarize the demo document.");
```

The repo’s **`examples/rag/src/demoAdapters.ts`** implements **`EmbeddingAdapter`** + **`VectorAdapter`** with a tiny in-memory vector store (hashing + cosine) for local demos only — swap for OpenAI/Upstash/etc. in production.

## Fragments from `examples/rag-contact-support`

Same RAG registration pattern, plus **`InMemoryRunStore`**, **`Session.sessionContext`** (e.g. **`customerEmail`**). The real example defines **`Tool.define({ id: "contact_support", … })`** and **`Skill.define({ id: "contact-support-skill", tools: ["contact_support"], … })`** before **`registerRagCatalog`**.

```typescript
// Adapted from examples/rag-contact-support/src/main.ts (middle section)
const runStore = new InMemoryRunStore();

const runtime = new AgentRuntime({
  llmAdapter: createScriptedSupportLlm({ /* … */ }),
  memoryAdapter: new InMemoryMemoryAdapter(),
  runStore,
  embeddingAdapter: createDemoEmbeddingAdapter(),
  vectorAdapter: createDemoVectorAdapter(),
  fileReadRoot: DEMO_FILE_READ_ROOT,
  maxIterations: 20,
});

await registerRagToolsAndSkills();
registerRagCatalog(runtime, PROJECT_ID, SUPPORT_RAG_SOURCES);

await Agent.define({
  id: "support-copilot",
  projectId: PROJECT_ID,
  systemPrompt: [
    "You are a support copilot.",
    "Use RAG tools: system_list_rag_sources, system_ingest_rag_source, system_vector_search as needed.",
    "contact_support requires subject, body, and category; customer email comes from session context and/or the tool input.",
  ].join(" "),
  tools: [],
  skills: ["rag", "contact-support-skill"],
  llm: { provider: "openai", model: "gpt-4o-mini" },
  security: { roles: ["agent", "admin", "operator"] },
});

const session = new Session({
  id: "session-support-1",
  projectId: PROJECT_ID,
  sessionContext: cliEmail ? { customerEmail: cliEmail } : {},
});
```

**`wait` / `resume`** (when the scripted flow pauses for email):

```typescript
// Adapted from examples/rag-contact-support/src/main.ts
let run = await agent.run(refundMessage);

if (run.status === "waiting") {
  const resumeText = await readUserResumeMessageAsEmail(/* … */);
  run = await agent.resume(run.runId, { type: "text", content: resumeText });
}
```

Support handbook catalog shape (same idea as `examples/rag`, different files):

```typescript
// Adapted from examples/rag-contact-support/src/fileSources.ts
export const SUPPORT_RAG_SOURCES: RagSourceDefinition[] = [
  {
    id: "support-handbook",
    description:
      "Internal support handbook: refunds, international orders, escalation, and contact reference.",
    source: "support-handbook.md",
  },
];
```

## Docs & full examples

- Pipeline & patterns: `docs/reference/core/18-rag-pipeline.md`
- Definitions / sandboxing: `docs/reference/core/06-definition-syntax.md`
- Package README: `packages/rag/README.md`
- Runnable sources (monorepo clone only): `examples/rag/`, `examples/rag-contact-support/`

## Tools (high level)

- **Catalog / ingest:** `system_list_rag_sources`, `system_ingest_rag_source`
- **Search / files:** `system_vector_search`, `system_file_read`, `system_file_ingest`, `system_file_list` (see package exports and tests for exact contracts)

## Gotchas

- **Demo adapters** vs **production** vector backends—call out when an example uses in-memory or permissive settings.
- **`fileReadRoot`** / session overrides for sandboxing—see `docs/reference/core/06-definition-syntax.md` and `packages/rag/README.md`.

For the full monorepo and every `docs/reference/core/` topic, enable the **`opencoreagents-workspace`** skill alongside this one.
