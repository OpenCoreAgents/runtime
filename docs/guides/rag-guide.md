# RAG Guide

Status: stable  
Audience: users, contributors

This guide shows how to add Retrieval-Augmented Generation (RAG) to an agent in OpenCore Agents.

## What You Build

A RAG agent that can:

- list available knowledge sources
- ingest source files into vector storage
- search semantically with `system_vector_search`
- answer using retrieved context

## Prerequisites

- You can run the repo (`pnpm install` and workspace builds).
- You have an `AgentRuntime` with:
  - `llmAdapter`
  - `memoryAdapter`
  - `embeddingAdapter`
  - `vectorAdapter`

Reference: [RAG pipeline](../reference/core/18-rag-pipeline.md), [Adapters contracts](../reference/core/05-adapters-contracts.md).

## Step 1: Register RAG tools and skills

```typescript
import { registerRagToolsAndSkills } from "@opencoreagents/rag";

await registerRagToolsAndSkills();
```

This registers the core RAG tools and the `rag` skill.

## Step 2: Register a project catalog

```typescript
import { registerRagCatalog } from "@opencoreagents/rag";

const projectId = "acme-support";

registerRagCatalog(runtime, projectId, [
  {
    id: "refund-policy",
    description: "Refund policy and processing windows",
    source: "./data/refund-policy.md",
  },
  {
    id: "shipping-playbook",
    description: "Shipping SLAs and exception handling",
    source: "./data/shipping-playbook.md",
  },
]);
```

Catalogs are project-scoped. Keep `Session.projectId`, `Agent.projectId`, and catalog `projectId` aligned.

## Step 3: Define an agent with the `rag` skill

```typescript
import { Agent } from "@opencoreagents/core";

await Agent.define({
  id: "support_rag",
  projectId: "acme-support",
  systemPrompt: "Answer support questions using retrieved evidence.",
  skills: ["rag"],
  llm: { provider: "openai", model: "gpt-4o-mini" },
});
```

## Step 4: Set file sandbox root

Use `fileReadRoot` so ingest tools can resolve relative `source` paths safely:

```typescript
const runtime = new AgentRuntime({
  llmAdapter,
  memoryAdapter,
  embeddingAdapter,
  vectorAdapter,
  fileReadRoot: "/absolute/path/to/knowledge-base",
});
```

You can also override per session (`Session.fileReadRoot`).

## Step 5: Run and observe

```typescript
const agent = await Agent.load("support_rag", runtime, {
  session: new Session({ id: "s1", projectId: "acme-support" }),
});

const run = await agent
  .run("A customer says their refund is delayed. What should support do next?")
  .onAction((a) => console.log("[action]", a.tool))
  .onObservation((o) => console.log("[observation]", o.value));

console.log(run.status);
```

Typical flow:

1. `system_list_rag_sources`
2. `system_ingest_rag_source`
3. `system_vector_search`
4. final `result`

## Production Notes

- Replace in-memory vector stores with Redis/Upstash-backed adapters.
- Keep vector namespace isolation by `projectId`.
- For multi-worker deployments, ensure all workers share consistent runtime wiring.

References:

- [Cluster deployment](../reference/core/16-cluster-deployment.md)
- [Scope and security](../reference/core/11-scope-and-security.md)
- [Multi-tenancy](../reference/core/12-multi-tenancy.md)

## Runnable Example

Start from the sample project:

- [examples/rag](../../examples/rag/README.md)
- [examples/rag-contact-support](../../examples/rag-contact-support/README.md)

It includes:

- scripted LLM mode (no API keys)
- optional OpenAI mode
- catalog registration and ingest/search flow
- support escalation flow with `wait`/`resume`
