# Adapters: queues and Redis transports

Related: [05-adapters-contracts.md](./05-adapters-contracts.md) (MemoryAdapter, ToolAdapter, RunStore, full package inventory), [19-cluster-deployment.md](./19-cluster-deployment.md) (cluster layout, TCP vs REST).

## Install and environment (quick reference)

| Package | Add to your app | Typical configuration |
|---------|-----------------|------------------------|
| `@opencoreagents/adapters-bullmq` | `pnpm add @opencoreagents/adapters-bullmq` | Redis connection compatible with BullMQ (often same **`REDIS_URL`** as TCP engine adapters). |
| `@opencoreagents/adapters-redis` | `pnpm add @opencoreagents/adapters-redis` | **`REDIS_URL`** (`redis://…`). |
| `@opencoreagents/adapters-upstash` | `pnpm add @opencoreagents/adapters-upstash` | Upstash **Redis REST** URL + token; vector index endpoints for **`UpstashVectorAdapter`** (see README). |
| `@opencoreagents/adapters-openai` / `adapters-anthropic` | `pnpm add @opencoreagents/adapters-openai` (or `adapters-anthropic`) | Provider API keys and model ids (README + [10-llm-adapter.md](./10-llm-adapter.md)). |
| `@opencoreagents/adapters-http-tool` | `pnpm add @opencoreagents/adapters-http-tool` | Secrets map for template resolution; see [20-http-tool-adapter.md](./20-http-tool-adapter.md). |

**Where to read more:** each section below summarizes **when** to pick that integration. **Constructors, env vars, code samples, and export lists** live in **`packages/<package>/README.md`** (e.g. [adapters-redis/README.md](../../packages/adapters-redis/README.md), [adapters-upstash/README.md](../../packages/adapters-upstash/README.md)).

## Job queue adapter (primary: BullMQ)

This is **not** a third core contract inside the loop (unlike `MemoryAdapter` / `ToolAdapter`). It is **pluggable infrastructure** used by **consumers**: workers dequeue jobs and call the same entry points as the SDK or REST — `run` / `resume` with `RunInput` / `ResumeInput`. The engine core does not import BullMQ.

**Implementation priority:** **BullMQ on Redis** is the **first-class** path for async work and for waking runs after `wait` with `reason: scheduled` (delayed jobs, retries, DLQ, horizontal workers). Use **`@opencoreagents/adapters-bullmq`** for typed **`createEngineQueue`** and **`createEngineWorker`**. **`dispatchEngineJob(runtime, payload)`** and **`EngineJobPayload`** are implemented in **`@opencoreagents/core`** ([`dispatchJob.ts`](../../packages/core/src/engine/dispatchJob.ts), [`engineJobPayload.ts`](../../packages/core/src/engine/engineJobPayload.ts)); **`@opencoreagents/adapters-bullmq`** **re-exports** them so worker code can import queue + dispatch from one package. QStash stays a **secondary** HTTP-only alternative when you do not run Redis workers.

| Use | Role |
|-----|------|
| **Background runs** | API or webhook enqueues work; worker invokes the engine — avoids HTTP timeouts, adds retries and DLQ. |
| **Scheduled `wait`** | Delayed or repeatable jobs call `resume(runId, …)` when `reason: scheduled`. |
| **MessageBus backend** | Optional: one queue (or set of queues) per agent / `projectId` for `system_send_message` delivery with ordering and retries — still exposed to the engine as the same bus contract ([09-communication-multiagent.md](./09-communication-multiagent.md)). |

**Redis:** BullMQ expects a Redis deployment that supports its commands and connection model. If you already use Redis for `MemoryAdapter`, you can use the **same cluster** or a **dedicated** Redis for queues; validate provider compatibility (some serverless Redis products differ — test before committing). Full cluster deployment model: [19-cluster-deployment.md](./19-cluster-deployment.md).

**Usage:** **`createEngineQueue`** / **`createEngineWorker`** + **`runtime.dispatch(job.data)`** — copy-paste-ready sample in [adapters-bullmq/README.md](../../packages/adapters-bullmq/README.md).

### Alternative: Upstash QStash

When you **do not** want Redis-backed workers (e.g. purely serverless HTTP callbacks), **QStash** can trigger `POST /runs/:id/resume` (or equivalent) after a delay — same semantics as a BullMQ delayed job from the engine's perspective, different operational model. Use QStash as the **secondary** option when BullMQ is not a fit.

---

## Native TCP Redis (`@opencoreagents/adapters-redis`) — default for shared state

**Prefer this package** when you have a normal **`redis://`** / **`REDIS_URL`** (Docker, k8s, VM, or a vendor’s TCP endpoint). **`RedisMemoryAdapter`**, **`RedisRunStore`**, and **`RedisMessageBus`** use **`ioredis`** and match the **same key and stream layout** as the Upstash HTTP adapters, so you can swap transports without changing engine code. This is the **same connection style as BullMQ** — one Redis cluster can back queues and engine state.

**Vector** search is not in this package; use **`UpstashVectorAdapter`** from `@opencoreagents/adapters-upstash` for hosted vectors, or plug in another `VectorAdapter` implementation. See [19-cluster-deployment.md §7.1](./19-cluster-deployment.md#71-tcp-redis-vs-upstash-rest-vs-bullmq).

**Dynamic definitions:** **`RedisDynamicDefinitionsStore`** implements the **`DynamicDefinitionsStore`** facade from **`@opencoreagents/dynamic-definitions`** (**`store.methods`** for Redis I/O, **`store.Agent`** / **`Skill`** / **`HttpTool`** for CRUD); workers typically hydrate per job ([21-dynamic-runtime-rest.md](./21-dynamic-runtime-rest.md)).

**Exports and keys:** [adapters-redis/README.md](../../packages/adapters-redis/README.md) lists all public classes and how they align with [05-adapters-contracts.md](./05-adapters-contracts.md) key patterns.

---

## Upstash REST (`@opencoreagents/adapters-upstash`) — HTTP Redis + vector

Use **`@opencoreagents/adapters-upstash`** when you want **Upstash’s REST API** (serverless/edge-friendly, no long-lived TCP to Redis) or when you adopt **`UpstashVectorAdapter`** alongside **`UpstashRedisMemoryAdapter`** / **`UpstashRunStore`** / **`UpstashRedisMessageBus`** in one place. Same `MemoryAdapter` / `RunStore` / `MessageBus` contracts as [05-adapters-contracts.md](./05-adapters-contracts.md); MVP scope for Upstash is summarized in [`mvp.md` § Upstash adapters in MVP](../planning/mvp.md#upstash-adapters-in-mvp). **Async / scheduled `resume`:** implement **BullMQ** first (above); **QStash** remains the documented **alternative** for HTTP-triggered wakeups without a worker process.

**Exports and RAG:** [adapters-upstash/README.md](../../packages/adapters-upstash/README.md); vector tools and pipeline — [17-rag-pipeline.md](./17-rag-pipeline.md).
