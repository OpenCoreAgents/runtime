# `@opencoreagents/adapters-anthropic`

**`AnthropicLLMAdapter`** (Messages API) for use with **`@opencoreagents/core`**.

## Install

```bash
pnpm add @opencoreagents/core @opencoreagents/adapters-anthropic
```

## Minimal use (`AgentRuntime`)

```typescript
import { AgentRuntime, InMemoryMemoryAdapter } from "@opencoreagents/core";
import { AnthropicLLMAdapter } from "@opencoreagents/adapters-anthropic";

const runtime = new AgentRuntime({
  llmAdapter: new AnthropicLLMAdapter(process.env.ANTHROPIC_API_KEY!),
  memoryAdapter: new InMemoryMemoryAdapter(),
});
```

Optional second argument: **`baseUrl` string** or **`AnthropicLLMAdapterOptions`** (`baseUrl`, `anthropicVersion`).

## Related docs

[`docs/reference/core/05-adapters-contracts.md`](../../docs/reference/core/05-adapters-contracts.md) (inventory + wiring), [`docs/reference/core/07-llm-adapter.md`](../../docs/reference/core/07-llm-adapter.md) (contract).
