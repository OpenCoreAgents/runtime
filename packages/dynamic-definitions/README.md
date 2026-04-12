# `@opencoreagents/dynamic-definitions`

REST-friendly **persistence + registry** for **agents**, **skills**, and **JSON HTTP tools** (via `@opencoreagents/adapters-http-tool`). Definitions are **project-scoped**; `scope: "global"` is rejected for store-backed rows.

## Concepts

- **`DynamicDefinitionsStoreMethods`** — low-level contract: `save*` / `list*` / `getSnapshot`. Exposed as **`store.methods`** on the facade.
- **`DynamicDefinitionsStore`** — facade: **`store.methods`** + **`store.Agent`**, **`store.Skill`**, **`store.HttpTool`**, **`store.syncProject`** (equivalent to **`bindDefinitions`** applied to **`store.methods`**).
- **`InMemoryDynamicDefinitionsStore`** — in-memory facade (tests / demos).
- **Redis:** **`RedisDynamicDefinitionsStore`** from **`@opencoreagents/adapters-redis`** — same facade shape; **`store.methods`** talks to Redis HASHes.
- **`bindDefinitions(methodsOrFacade)`** — optional helper; resolves **`store.methods`** if you pass a facade. Usually unnecessary if you use **`InMemoryDynamicDefinitionsStore`** / **`RedisDynamicDefinitionsStore`**.
- **`hydrateAgentDefinitionsFromStore(storeOrMethods, projectId, agentId, { secrets? })`** — accepts a facade or bare **`methods`**; loads that agent (+ skills + HTTP tools) into the process registry **per job**. **`store.Agent.prepare`** does the same.
- **`syncProjectDefinitionsToRegistry`** — optional full-project replay (warm cache). Prefer per-job hydrate for workers.
- Pass **`dynamicDefinitionsStore`** (facade or bare methods) into **`AgentRuntime`** so **`dispatch`** / **`dispatchEngineJob`** hydrates automatically: **`core`** dynamically imports this package when the store is set (install **`@opencoreagents/dynamic-definitions`** in the worker app; it is not a build-time dependency of **`core`**).

**Secrets** for **`{{secret:*}}`** in HTTP tool templates are passed at registration time (**`HttpToolSecretsOptions.secrets`**), not stored inside public JSON.

## Install

Workspace / monorepo: depend on **`@opencoreagents/dynamic-definitions`**, **`@opencoreagents/core`**, and (for HTTP tools) **`@opencoreagents/adapters-http-tool`**.

## Related docs

[`docs/core/21-dynamic-runtime-rest.md`](../docs/core/21-dynamic-runtime-rest.md), [`docs/core/20-http-tool-adapter.md`](../docs/core/20-http-tool-adapter.md).
