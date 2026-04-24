# `@opencoreagents/adapters-openai`

**`OpenAILLMAdapter`** (Chat Completions) and **`OpenAIEmbeddingAdapter`** for use with **`@opencoreagents/core`**.

## Install

```bash
pnpm add @opencoreagents/core @opencoreagents/adapters-openai
```

## Minimal use (`AgentRuntime`)

```typescript
import { AgentRuntime, InMemoryMemoryAdapter } from "@opencoreagents/core";
import { OpenAILLMAdapter } from "@opencoreagents/adapters-openai";

const runtime = new AgentRuntime({
  llmAdapter: new OpenAILLMAdapter(process.env.OPENAI_API_KEY!),
  memoryAdapter: new InMemoryMemoryAdapter(),
});
```

Optional second constructor argument: **OpenAI-compatible `baseUrl`** (default `https://api.openai.com/v1`). For embeddings / RAG, use **`OpenAIEmbeddingAdapter`** (see source `OpenAIEmbeddingAdapterOptions`).

## Related docs

[`docs/reference/core/05-adapters-contracts.md`](../../docs/reference/core/05-adapters-contracts.md) (inventory + wiring), [`docs/reference/core/07-llm-adapter.md`](../../docs/reference/core/07-llm-adapter.md) (contract).
