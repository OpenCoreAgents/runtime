# Browser-Local Agent Runtime

## Idea

Enable OpenCore Agents to run entirely inside a web application with a local language model. The browser would own execution, memory, run history, and agent definitions, without requiring Express, Redis, BullMQ, API keys, or a remote runtime.

This should extend the project rather than move browser-specific behavior into `@opencoreagents/core`.

## Why This Is Useful

- Private prompts and data can remain on the user's device.
- Applications can work offline after model and asset caching.
- Developers can embed agents without operating backend infrastructure.
- Local demos and prototypes become easier to distribute.
- The same core agent abstractions can support both server and browser deployments.

## Design Principle

`@opencoreagents/core` should remain environment-neutral and preserve its current behavior. Browser integrations should live in a separate package, tentatively named:

```text
@opencoreagents/browser
```

Changes to `core` should be limited to portability seams required for browser bundling. They must not change agent execution semantics, protocol behavior, memory scope, run lifecycle, or existing Node.js APIs.

## Proposed Architecture

```text
Web application
  |
  +-- @opencoreagents/core
  |     Agent, Session, AgentRuntime, execution engine
  |
  +-- @opencoreagents/browser
        IndexedDBMemoryAdapter
        IndexedDBRunStore
        IndexedDBDefinitionsStore (optional)
        browser-safe ID and persistence utilities
  |
  +-- Optional local model provider subpath
        WebLLM, Transformers.js, or another WebGPU/WASM runtime
```

The first proof of concept can use the existing in-memory components:

- `InMemoryMemoryAdapter`
- `InMemoryRunStore`
- `InProcessMessageBus`
- `InMemoryDynamicDefinitionsStore`

IndexedDB adapters can be added afterward for persistence across page reloads.

## Minimal Core Compatibility Work

The current core package contains Node-specific references such as `node:crypto` and direct access to `process.env`. These prevent clean browser bundling even when every selected adapter is browser-compatible.

The preferred change is to introduce small environment-neutral seams:

1. Generate IDs through an internal utility that uses `globalThis.crypto.randomUUID()` when available.
2. Keep a safe fallback for supported environments without `crypto.randomUUID()`.
3. Replace direct `process.env` access with a guarded environment check or injected development diagnostics option.
4. Add a browser bundling test to prevent accidental Node-only imports from returning to `core`.

These changes should preserve current Node.js output and behavior. They are portability fixes, not browser features.

## Browser Package Responsibilities

### `BrowserLLMAdapter`

Implement the existing `LLMAdapter` contract and translate core requests into the selected local model API. The first implementation should target one provider only, likely WebLLM, while leaving room for additional providers.

Responsibilities include:

- Model loading and progress events
- Prompt and message conversion
- Streaming or complete generation
- Cancellation through `AbortSignal`
- Tool-call or structured-output normalization
- Capability and device checks

### Persistent Adapters

IndexedDB implementations should follow existing core contracts and avoid introducing browser persistence concepts into `core`:

- `IndexedDBMemoryAdapter`
- `IndexedDBRunStore`
- `IndexedDBDynamicDefinitionsStore`

The database should use explicit schema versions and migrations. Data should be partitioned by `projectId`, session, and agent consistently with existing adapter semantics.

### In-Process Communication

`InProcessMessageBus` is sufficient for a single browser tab. Cross-tab communication could later be implemented with `BroadcastChannel`, but it is not required for the initial version.

## Example API

```ts
import {
  Agent,
  AgentRuntime,
  Session,
  InMemoryMemoryAdapter,
} from "@opencoreagents/core";
import { WebLLMAdapter } from "@opencoreagents/browser";

const runtime = new AgentRuntime({
  llmAdapter: new WebLLMAdapter({
    model: "a-browser-compatible-instruct-model",
  }),
  memoryAdapter: new InMemoryMemoryAdapter(),
});

const session = new Session({
  id: crypto.randomUUID(),
  projectId: "local-browser-demo",
});

const agent = await Agent.load("local-assistant", runtime, { session });
const run = await agent.run("Summarize my notes.");
```

The final API will depend on the selected local-model library and its model-loading lifecycle.

## Security and Privacy

Local execution reduces server exposure but does not automatically make an application secure.

- Do not ship conventional provider API keys in browser bundles.
- Clearly identify tools that make network requests.
- Require explicit user action before exposing local files or sensitive browser data.
- Document that IndexedDB data is accessible to scripts running under the same origin.
- Consider an application-level option to disable all network-capable tools.
- Avoid claiming full offline behavior unless model assets and application resources are cached.

## Constraints

- WebGPU availability and performance vary across browsers and devices.
- Model downloads can be large and slow on first use.
- Mobile memory limits may restrict usable models.
- Structured tool calling may require model-specific prompting and parsing.
- Browser tabs can be suspended, terminated, or reloaded during a run.
- In-memory adapters lose all state on reload.
- IndexedDB durability does not provide multi-device synchronization.

## Suggested Delivery Plan

Current status: Phases 1-3 are implemented. Phase 4 is in progress, with the deterministic browser path, IndexedDB lifecycle, and package boundaries taking priority over additional model integrations.

### Phase 1: Browser compatibility spike

Status: complete.

- Remove Node-only bundling blockers from `core` without changing behavior.
- Add a minimal Vite application.
- Run a deterministic mock `LLMAdapter` in the browser.
- Verify agent definition, loading, execution, memory, and run completion.

### Phase 2: Local model proof of concept

Status: complete as an optional integration. Further model-provider work is deferred.

- Add `@opencoreagents/browser`.
- Implement one local-model adapter.
- Display model-loading progress and unsupported-device errors.
- Demonstrate a complete local agent run without a server.

### Phase 3: Persistence

Status: complete.

- Implement IndexedDB memory and run stores.
- Add schema migration and cleanup behavior.
- Verify state restoration after reload.

### Phase 4: Production hardening

Status: in progress.

- Add bundle-size and browser compatibility checks.
- Test cancellation, tab reloads, storage limits, and model failures.
- Document privacy boundaries and network-capable tools.
- Define storage quota and eviction behavior.
- Add cross-tab coordination only if a concrete multi-tab use case requires it.

## Acceptance Criteria for the First Proof of Concept

- A Vite application imports `@opencoreagents/core` without Node polyfills.
- An agent runs entirely in the browser using a deterministic adapter.
- A second demo runs with a local WebGPU or WASM model.
- No application server, Redis instance, BullMQ worker, or remote API key is required.
- Existing Node.js tests and examples continue to behave as before.
- Browser-specific code remains outside `core`, except for narrowly scoped portability utilities.

## Deferred Questions

- Should another local-model runtime be supported after WebLLM?
- Should IndexedDB adapters eventually move to a dedicated persistence package?
- Should the optional model entrypoints share a common initialization contract?
- What minimum browser and WebGPU support policy should the package adopt?

## Recommendation

Start with a deterministic browser demo before integrating a real model. This isolates bundling and portability issues from WebGPU and model-runtime complexity. Once the core execution path is proven in a browser, add one local-model adapter in `@opencoreagents/browser` and keep all persistence optional.

This approach protects the stability of `core`, creates a clean extension point, and provides a credible path toward a private, offline-capable agent runtime.
