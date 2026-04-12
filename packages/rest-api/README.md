# `@opencoreagents/rest-api`

**Plugin-style** Express **`Router`**: after you **`Agent.define`** (and tools/skills), mount **`createPlanRestRouter({ … })`** to expose **plan-rest-shaped** JSON routes without copying handlers from scratch.

**Execution modes**

| Mode | Options | Behavior |
|------|---------|----------|
| **Inline** (default) | **`runtime`** | **`POST` run/resume** call **`Agent.run` / `resume`** in the HTTP process (same as before). |
| **Queue** | **`dispatch: { engine, queueEvents?, jobWaitTimeoutMs? }`** | **`POST` run/resume** call **`engine.addRun` / `addResume`** — same job payload as **`examples/dynamic-runtime-rest`**. Default **202** + **`jobId`** + **`statusUrl`**; **`?wait=1`** or **`"wait": true`** blocks until the worker finishes (**needs `queueEvents`**). |
| **Both** | **`runtime` + `dispatch`** | **`dispatch`** wins for **`POST` run/resume**; **`runtime`** still used if you omit **`dispatch`** (not typical). |

Install **`@opencoreagents/adapters-bullmq`** and **`bullmq`** when using **`dispatch`** (optional **peer** dependencies).

## Routes

| Method | Path | Notes |
|--------|------|-------|
| **GET** | `/agents` | With **`agentIds`**: that allowlist. Without: every agent the registry can resolve for the effective **`projectId`** (same as **`Agent.load`**). |
| **POST** | `/agents/:agentId/run` | Body: `{ "message": string, "sessionId"?: string, "projectId"?: string, "wait"?: boolean }`. **`wait`**: only with **`dispatch`** (+ **`queueEvents`**). |
| **POST** | `/agents/:agentId/resume` | Body: `{ runId, sessionId, resumeInput, "projectId"?, "wait"? }`. **Inline** mode needs **`runStore`** on **`AgentRuntime`**. **Queue** mode does not need **`runStore`** on the API process (worker must persist runs). |
| **GET** | `/runs/:runId?sessionId=` | Requires **`runStore`**. In **multi-project** mode, also send **`X-Project-Id`** or **`?projectId=`** (same resolution as below). |
| **GET** | `/jobs/:jobId` | Only when **`dispatch`** is set — poll BullMQ job (**`state`**, **`run`** summary when completed), same idea as **`GET /v1/jobs/:id`** in **`dynamic-runtime-rest`**. |

Optional **`apiKey`**: if set, clients must send **`Authorization: Bearer …`** or **`X-Api-Key`**.

### One fixed project

Pass **`projectId`** in options. Clients do not need a tenant header; **`X-Project-Id`** / **`?projectId=`** are ignored.

### Many projects (multi-tenant)

Omit **`projectId`** from options. Each request resolves the tenant in order:

1. Header **`X-Project-Id`**
2. Query **`?projectId=`** (works for **GET** and **GET /runs**)
3. JSON **`body.projectId`** (works for **POST** run/resume)

Optional **`allowedProjectIds`**: if set (and not wildcard-only), any other **`projectId`** gets **403**. Use **`["*"]`** to accept **any** resolved tenant (still require header/query/body **`projectId`** in multi mode; use **`apiKey`** in production).

When **`agentIds` is omitted**, every agent registered for that tenant (plus globals) is invocable — use **`agentIds`** to restrict agent names.

## Usage

**Single project** (simplest):

```typescript
import express from "express";
import { createPlanRestRouter } from "@opencoreagents/rest-api";
import { Agent, AgentRuntime, InMemoryMemoryAdapter, InMemoryRunStore } from "@opencoreagents/core";

const runStore = new InMemoryRunStore();
const runtime = new AgentRuntime({
  llmAdapter: /* … */,
  memoryAdapter: new InMemoryMemoryAdapter(),
  runStore,
});

await Agent.define({
  id: "my-agent",
  projectId: "my-project",
  // …
});

const app = express();
app.use(
  createPlanRestRouter({
    runtime,
    projectId: "my-project",
    runStore,
    apiKey: process.env.REST_API_KEY,
  }),
);

app.listen(3000);
```

**Several projects** on one router (clients send the tenant per request):

```typescript
await Agent.define({ id: "assistant", projectId: "acme", /* … */ });
await Agent.define({ id: "assistant", projectId: "contoso", /* … */ });

app.use(
  createPlanRestRouter({
    runtime,
    allowedProjectIds: ["acme", "contoso"],
    runStore,
  }),
);
// e.g. curl -H "X-Project-Id: acme" http://localhost:3000/agents
// or POST …/run with { "projectId": "acme", "message": "hi" }
```

Open multi-tenant (any project id the client sends, after resolution):

```typescript
app.use(
  createPlanRestRouter({
    runtime,
    allowedProjectIds: ["*"],
    runStore,
    apiKey: process.env.REST_API_KEY, // recommended
  }),
);
```

**BullMQ enqueue** (worker runs **`AgentRuntime.dispatch`** — see [`examples/dynamic-runtime-rest/`](../../examples/dynamic-runtime-rest/)):

```typescript
import { createEngineQueue } from "@opencoreagents/adapters-bullmq";
import { QueueEvents } from "bullmq";
import Redis from "ioredis";

const connection = { host: "127.0.0.1", port: 6379 };
const engine = createEngineQueue("engine", connection);
const queueEvents = new QueueEvents("engine", { connection });
await queueEvents.waitUntilReady();

app.use(
  createPlanRestRouter({
    dispatch: {
      engine,
      queueEvents,
      jobWaitTimeoutMs: 120_000,
    },
    projectId: "my-project",
    // runtime optional — list agents from in-process registry or define agents in API + worker bootstrap
  }),
);
// POST …/run → 202 { jobId, statusUrl } or ?wait=1 → 200 { runId, status, reply? }
```

Override resolution with **`resolveProjectId(req)`** if you use JWT claims or a path prefix. **`defaultPlanRestResolveProjectId`** is exported if you want to extend the default chain.

Mount under a prefix: **`app.use("/api", createPlanRestRouter({ … }))`** → **`GET /api/agents`**, etc.

### OpenAPI / Swagger UI

Set **`swagger: true`** (or an object) on **`createPlanRestRouter`** to add:

- **`GET …/openapi.json`** — OpenAPI **3.0** document (paths match this router).
- **`GET …/docs`** — Swagger UI (loads **Swagger UI** from [unpkg](https://unpkg.com/); allow that CDN in **`Content-Security-Policy`** if you use one).

Defaults: **`openapi.json`** + **`docs`**. Customize with **`swagger: { openApiPath, uiPath, info?: { title, version, description } }`**.

These routes are registered **before** **`apiKey`** and tenant middleware, so they do not require **`Authorization`** or **`X-Project-Id`**. Put **`app.use`** in front of the router if you need to protect them.

You can also call **`buildPlanRestOpenApiSpec({ … })`** and **`planRestSwaggerUiHtml(openApiPath, uiPath)`** from **`@opencoreagents/rest-api`** to serve the spec or UI yourself.

## Docs

[`docs/plan-rest.md`](../../docs/plan-rest.md) (full roadmap). This package implements a **minimal** subset aligned with the target shape; async **202 + BullMQ** remains app-specific (see [`examples/dynamic-runtime-rest/`](../../examples/dynamic-runtime-rest/)).
