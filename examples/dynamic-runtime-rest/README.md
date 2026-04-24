# `dynamic-runtime-rest` — Redis + BullMQ + runtime `dynamicDefinitionsStore`

Production-shaped layout from [`docs/reference/core/21-dynamic-runtime-rest.md`](../../docs/reference/core/21-dynamic-runtime-rest.md):

| Layer | This example |
|--------|----------------|
| Definitions | **`RedisDynamicDefinitionsStore`** (HASH keys `{DEF_KEY_PREFIX}:{projectId}:…`) |
| Run execution | **`createEngineWorker`** + **`runtime.dispatch`** (same as **`dispatchEngineJob`**) |
| Per job | **`AgentRuntime`** with **`dynamicDefinitionsStore`** + optional **`dynamicDefinitionsSecrets`** — core calls **`hydrateAgentDefinitionsFromStore`** before **`Agent.load`** |
| API | Express **CRUD** via **`store.Agent` / `store.Skill` / `store.HttpTool`** + **`store.methods.getSnapshot`**; **`POST /v1/run`** → **enqueue** only (no inline engine) |

## Prerequisites

- **Redis** reachable at **`REDIS_URL`** (default `redis://127.0.0.1:6379`).
- Two terminals: **API** and **worker**.

```bash
docker run --rm -p 6379:6379 redis:7-alpine
```

## Install & build deps

From the repo root:

```bash
pnpm install
pnpm turbo run build --filter=@opencoreagents/core --filter=@opencoreagents/dynamic-definitions --filter=@opencoreagents/adapters-http-tool --filter=@opencoreagents/adapters-redis --filter=@opencoreagents/adapters-bullmq
```

## Run

Terminal A (worker — must be up before synchronous runs):

```bash
pnpm --filter @opencoreagents/example-dynamic-runtime-rest start:worker
```

Terminal B (API):

```bash
pnpm --filter @opencoreagents/example-dynamic-runtime-rest start:api
```

Env:

| Variable | Default | Role |
|----------|---------|------|
| **`REDIS_URL`** | `redis://127.0.0.1:6379` | Definitions + BullMQ |
| **`PORT`** | `3010` | API |
| **`PROJECT_ID`** | `dynamic-demo` | Tenant id in routes |
| **`ENGINE_QUEUE_NAME`** | `agent-engine-runs` | BullMQ queue (API + worker must match) |
| **`DEF_KEY_PREFIX`** | `def` | Redis key prefix for definition hashes |
| **`RUN_WAIT_TIMEOUT_MS`** | `60000` | `wait=1` wait cap (legacy env: **`RUN_SYNC_TIMEOUT_MS`**) |
| **`HTTP_TOOL_SECRETS_JSON`** | — | Worker only: `{"API_KEY":"…"}` for `{{secret:API_KEY}}` in HTTP tools (never put secrets in job payloads) |

## Routes (summary)

| Method | Path | Notes |
|--------|------|--------|
| **GET** | `/health` | Liveness |
| **GET** | `/v1/definitions` | Snapshot for **`PROJECT_ID`** (`store.methods.getSnapshot`) |
| **PUT** | `/v1/http-tools/:toolId` | **`HttpToolConfig`**; optional **`_secrets`** only affects the **API** process (worker uses **`HTTP_TOOL_SECRETS_JSON`**) |
| **PUT** | `/v1/skills/:skillId` | **`SkillDefinitionPersisted`** |
| **PUT** | `/v1/agents/:agentId` | **`AgentDefinitionPersisted`** |
| **GET** | `/v1/jobs/:jobId` | BullMQ job state + summarized **`Run`** when completed |
| **POST** | `/v1/run` | Enqueue run; **`?wait=1`** or **`"wait": true`** blocks until done |

## Flow

1. **PUT** `/v1/agents/:id`, `/v1/skills/:id`, `/v1/http-tools/:id` → Redis (+ local registry in the API process; workers re-read from Redis on each job).
2. **`POST /v1/run`** with `{ "agentId", "message" }` and optional **`sessionId`** (omit or empty → API assigns a new UUID and returns it in the response for follow-up messages):
   - Default: **`202`** + `{ "jobId", "statusUrl" }` — poll **`GET /v1/jobs/:jobId`**.
   - **`?wait=1`** or body **`"wait": true`** — blocks until the worker finishes (BullMQ **`waitUntilFinished`**, capped by **`RUN_WAIT_TIMEOUT_MS`**). On timeout the API responds **`504`**; other wait failures **`502`** (see **`v1Router.ts`**).
3. Worker: **`runtime.dispatch(job.data)`** (same engine path as **`dispatchEngineJob`**) — if **`dynamicDefinitionsStore`** is set, **`core`** hydrates from Redis then **`Agent.load`** → **`run` / `resume`**.

## Security note

This sample has **no auth**, **no rate limits**, and **no JSON-schema validation** on definition PUTs. Add tenant resolution, authn/z, and payload limits before exposing it. Malformed **`HTTP_TOOL_SECRETS_JSON`** on the worker yields **empty** secrets (no throw).
