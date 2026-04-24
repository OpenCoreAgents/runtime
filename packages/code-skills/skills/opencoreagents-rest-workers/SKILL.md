---
name: opencoreagents-rest-workers
description: Express REST for agents/runs (@opencoreagents/rest-api), BullMQ async dispatch (adapters-bullmq), Redis-backed dynamic definitions and workers (dynamic-runtime-rest).
---

# OpenCore Agents — REST API & workers

> **Bundled docs:** **`docs/core/15-multi-tenancy.md`** (engine tenancy / scopes); **`docs/core/21-dynamic-runtime-rest.md`** (dynamic store + workers); **`packages/rest-api/README.md`**, **`packages/core/README.md`**. **`skillDocsDirectory("opencoreagents-rest-workers")`**, **`skillPackagesDirectory("opencoreagents-rest-workers")`**.

Use for **HTTP APIs over the engine**, **BullMQ-backed run/resume**, and **Redis + worker** setups—not for in-process-only demos unless the user asks for HTTP.

Same stack as the public monorepo [OpenCoreAgents/runtime](https://github.com/OpenCoreAgents/runtime).

## Packages (install what you use)

| Package | Role |
|---------|------|
| **`@opencoreagents/rest-api`** | **`createRuntimeRestRouter`** → Express **`Router`** (URL shape summarized below; more options in **`packages/rest-api/README.md`**) |
| **`@opencoreagents/adapters-bullmq`** | **`createEngineQueue`**, **`createEngineWorker`**; re-exports **`dispatchEngineJob`** from **`core`** |
| **`@opencoreagents/dynamic-definitions`** | **`hydrateAgentDefinitionsFromStore`**, persisted agent/skill/HTTP-tool shapes |
| **`@opencoreagents/adapters-redis`** | **`RedisDynamicDefinitionsStore`**, shared **Memory** / **RunStore** when you need Redis |

**`rest-api`** lists **`adapters-bullmq`** / **`bullmq`** as **optional peers**—add them when using **`dispatch`**.

## HTTP contract summary (`@opencoreagents/rest-api`)

**What it is:** an Express **`Router`**—not a standalone “REST server” binary. You own **listen port**, **TLS**, **rate limits**, **auth beyond API keys**, and any **extra routes**.

**Implemented paths (relative to where you mount the router):**

| Method | Path | Purpose |
|--------|------|---------|
| **GET** | `/agents` | List agent ids for the effective **`projectId`** (optional **`agentIds`** allowlist). |
| **GET** | `/agents/:agentId/memory` | Read memory via **`MemoryAdapter.query`** — needs **`runtime`**; query **`sessionId`** + **`memoryType`** required; optional **`endUserId`**. **Unregistered** if the router is enqueue-only (**`dispatch`** without **`runtime`**). |
| **POST** | `/agents/:fromAgentId/send` | Inter-agent **`MessageBus.send`** (same idea as **`system_send_message`**). Needs **`runtime`** + **`messageBus`** on **`AgentRuntime`** (**501** if missing). Optional **`sendMessageTargetPolicy`** can **403**. |
| **POST** | `/agents/:agentId/run` | Start a run — body **`message`** (required), optional **`sessionId`**, **`projectId`**, **`wait`**. Inline → **`Agent.run`**. Queue → **202** + **`jobId`** / **`statusUrl`**, or block with **`wait`** + **`queueEvents`**. |
| **POST** | `/agents/:agentId/resume` | Resume a **`wait`** — **`runId`**, **`sessionId`**, **`resumeInput`** `{ type, content }`, optional **`projectId`**, **`wait`**. Inline needs **`runStore`** on **`AgentRuntime`**. |
| **GET** | `/runs/:runId` | Run snapshot from **`runStore`** — **`?sessionId=`** required; exact **`projectId`** match and optional **`?tenantId=`** for tenant-scoped runs (**403** mismatch). |
| **GET** | `/runs/:runId/history` | Full **`Run.history`** — same **`sessionId`** / project / tenant rules as **`GET /runs/:runId`**. |
| **GET** | `/agents/:agentId/runs` | List runs — needs **`runStore`**; optional **`status`**, **`sessionId`**, **`tenantId`**, **`limit`**. Uses **`listByAgentAndSession(projectId, agentId, sessionId, { tenantId?, ... })`** when **`sessionId`** is supplied. |
| **GET** | `/jobs/:jobId` | BullMQ job status + run summary when done — **only** if **`dispatch`** is configured. |

**Execution modes** (how run/resume run):

| Mode | Config | Effect |
|------|--------|--------|
| **Inline** | **`runtime`** | **`POST …/run`** and **`POST …/resume`** execute in the HTTP process. **`resume`** and **`GET /runs*`** need **`runStore`** on **`AgentRuntime`**. |
| **Queue** | **`dispatch: { engine, queueEvents?, jobWaitTimeoutMs? }`** | Run/resume **enqueue**; default **202** + **`jobId`**. **`wait`** needs **`queueEvents`**. **`isBullmqJobWaitTimeoutError`** → **504** vs **502**. |
| **Both** | **`runtime` + `dispatch`** | **`dispatch`** wins for **`POST` run/resume**; **`runtime`** still powers memory/send routes when mounted. |

**Multi-tenant resolution** (when **`projectId`** is omitted from router options): **`X-Project-Id`** header → **`?projectId=`** → **`body.projectId`** on POSTs. Optional run **`tenantId`** resolves from **`X-Tenant-Id`** → **`?tenantId=`** → **`body.tenantId`**; set **`requiredTenant: true`** to require it on run routes. **`allowedProjectIds`**, **`resolveProjectId(req)`**, **`resolveApiKey`** + **`getRuntimeRestRouterProjectId`** / **`getRuntimeRestRouterTenantId`** for scoped secrets — see **`packages/rest-api/README.md`**.

**Engine-level multi-tenancy:** the router only picks the effective **`projectId`** on the wire. How **`projectId`** scopes **definitions**, **memory**, **runs**, **`RunStore`** rows, **`MessageBus`** keys, and **dynamic-definition** store data lives in **`docs/core/15-multi-tenancy.md`**—read it when combining **`rest-api`** with **shared Redis**, **workers**, or **`dynamicDefinitionsStore`**, not only for “HTTP auth” questions.

**Useful exports:** **`mapEngineErrorToHttp`**, **`RUNTIME_REST_ENGINE_ERROR_CODES`**, **`isBullmqJobWaitTimeoutError`**, **`buildRuntimeRestOpenApiSpec`**, **`swagger`** option (**`/openapi.json`**, **`/docs`** — often **without** API key; lock down in production).

**Library limits (know the box):** JSON body cap (**512kb**); no **`endUserId` / `expiresAtMs`** on **`POST` run/resume`** HTTP bodies (use **queue** / **`EngineJobPayload`** if you need them); **no** define-CRUD routes inside this router; **no** built-in idempotency or rate limiting. **SSE / token streaming** is **not** in **`rest-api`** — use a custom BFF (e.g. monorepo **`examples/real-world-with-express`**) if you need that shape.

## Mounting & auth (minimal)

```typescript
import express from "express";
import { createRuntimeRestRouter } from "@opencoreagents/rest-api";

const app = express();
app.use(express.json());
app.use(
  createRuntimeRestRouter({
    runtime,
    projectId: "my-project", // omit for multi-tenant (see summary above + package README)
    runStore,
    resolveApiKey: () => process.env.REST_API_KEY?.trim() || undefined,
    // swagger: true  → GET …/openapi.json, GET …/docs (no API key by default—protect in production)
  }),
);
// Optional prefix: app.use("/api", createRuntimeRestRouter({ … }))
```

## BullMQ worker path

- **`dispatchEngineJob(runtime, payload)`** is implemented in **`@opencoreagents/core`** and **re-exported** from **`@opencoreagents/adapters-bullmq`**.
- Worker should build **`AgentRuntime`** with the same adapters you need in production (**Redis** memory/run store if multiple workers).
- **Dynamic agents:** set **`dynamicDefinitionsStore`** (e.g. **`RedisDynamicDefinitionsStore`**) on **`AgentRuntime`** so **`runtime.dispatch`** / **`dispatchEngineJob`** hydrates from Redis **per job**—details in **`docs/core/21-dynamic-runtime-rest.md`**.

## Dynamic definitions (mental model)

1. Definitions live in a **store** (usually **Redis**); **API** validates auth and **writes** + **enqueues**.
2. **Worker** runs **`hydrateAgentDefinitionsFromStore`** (or relies on **`dynamicDefinitionsStore`** on **`AgentRuntime`**) **before** **`Agent.load`** for that job—so Redis edits apply on the **next** job without redeploying workers.
3. **`@opencoreagents/core`** does **not** depend on **`dynamic-definitions`** at build time; workers must **install** **`@opencoreagents/dynamic-definitions`** so the dynamic import resolves.

**Reference:** **`examples/dynamic-runtime-rest/`** *(full monorepo clone only)* — infrastructure pattern; you can still mount **`createRuntimeRestRouter({ dispatch })`** on the same API if you want **`/agents/...`** paths alongside custom **`/v1/...`** routes.

## Production posture (stay honest)

The plugin gives routes and engine wiring, not a full product security boundary. Treat **multi-tenant isolation**, **API keys / auth**, **rate limits**, **OpenAPI/Swagger** (often public if you enable it), **idempotency** for queued or retried work, and **shared `RunStore`** consistency as **your** integration work—do not describe the stack as **hardened multi-tenant SaaS** unless you have actually implemented those layers.
