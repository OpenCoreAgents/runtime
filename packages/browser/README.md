# `@opencoreagents/browser`

Browser persistence and integration adapters for OpenCore Agents. The main package entry has no model-runtime dependency and can be used with any browser-compatible `LLMAdapter`.

## Install

```bash
pnpm add @opencoreagents/core @opencoreagents/browser
```

## IndexedDB persistence

```typescript
import { AgentRuntime } from "@opencoreagents/core";
import {
  IndexedDBMemoryAdapter,
  IndexedDBRunStore,
  closeOpenCoreBrowserDatabase,
  deleteOpenCoreBrowserDatabase,
} from "@opencoreagents/browser";

const databaseName = "my-local-agent";
const runtime = new AgentRuntime({
  llmAdapter: myBrowserCompatibleAdapter,
  memoryAdapter: new IndexedDBMemoryAdapter({ databaseName }),
  runStore: new IndexedDBRunStore({ databaseName }),
});

// Run only after an explicit user-controlled reset action.
await deleteOpenCoreBrowserDatabase(databaseName);

// Or release the cached connection while preserving data.
await closeOpenCoreBrowserDatabase(databaseName);
```

`IndexedDBMemoryAdapter` follows core memory partitioning: `longTerm` and `vectorMemory` are shared by `endUserId` when present; other memory remains session-scoped. `IndexedDBRunStore.saveIfStatus()` uses a single read-write transaction for atomic run transitions.

Stored memory, run state, and dynamic definitions must be structured-cloneable. If a payload contains functions, DOM nodes, or other unsupported values, the adapters reject with an IndexedDB serialization error so the application can surface a useful message.

### Dynamic agent definitions

```typescript
import {
  IndexedDBDynamicDefinitionsStore,
  hydrateBrowserDynamicDefinitions,
} from "@opencoreagents/browser";

const definitions = new IndexedDBDynamicDefinitionsStore({ databaseName });
await definitions.saveAgent("local-project", agentDefinition);

const runtime = new AgentRuntime({
  llmAdapter: myBrowserCompatibleAdapter,
  memoryAdapter,
  runStore,
  dynamicDefinitionsStore: definitions,
  dynamicDefinitionsHydrator: hydrateBrowserDynamicDefinitions,
});
```

Calling `runtime.dispatch()` hydrates the requested agent, its skills, and referenced HTTP tools before execution. Imperative JavaScript tool handlers still need to be registered by application code.

## Optional WebLLM integration

WebLLM is not loaded by the main package entry. Install it explicitly and import the integration subpath only when local WebGPU inference is required:

```bash
pnpm add @mlc-ai/web-llm
```

```typescript
import { WebLLMAdapter } from "@opencoreagents/browser/webllm";

const llmAdapter = new WebLLMAdapter({
  model: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
});
```

For worker-based inference, create a module worker with `@opencoreagents/browser/webllm-worker` and pass `createWebLLMWorkerEngineFactory` from the `/webllm` subpath. WebGPU support is required by the default engine factory.

## Security and durability

- IndexedDB is origin-scoped and accessible to scripts running on the same origin.
- Browser storage is durable across reloads but is not a multi-device synchronization mechanism.
- Do not embed conventional provider API keys in browser bundles.
- Require explicit user action before deleting local data or exposing sensitive browser data.
