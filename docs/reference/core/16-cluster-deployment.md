# Cluster deployment: multi-process and horizontal scaling

How the agent runtime behaves when multiple processes (workers, replicas, containers) run in parallel. What is per-process, what must be shared, and what changes in each layer.

Related: [Adapters contracts](./05-adapters-contracts.md), [Adapters infrastructure](./13-adapters-infrastructure.md) (queues, Redis packages), [Multi-agent communication](./14-communication-multiagent.md) (MessageBus), [Multi-tenancy](./12-multi-tenancy.md) (tenant isolation).

---

## Status (this repository)

| Area | Implemented | Planned / design only |
|------|-------------|------------------------|
| **RunStore** | `RunStore` in `@opencoreagents/core`; `InMemoryRunStore`; **`RedisRunStore`** (`@opencoreagents/adapters-redis`); `UpstashRunStore` (`@opencoreagents/adapters-upstash`); pass **`runStore`** into **`new AgentRuntime({ … })`**; `RunBuilder` persists after each run; `Agent.resume(runId, input)` | DB-backed `RunStore`, TTL/cleanup policies |
| **Job queue** | **`@opencoreagents/adapters-bullmq`** — `createEngineQueue`, `createEngineWorker`; **`dispatchEngineJob`** implemented in **`@opencoreagents/core`**, re-exported from **`adapters-bullmq`** (BullMQ **priority**) | QStash HTTP handler **not** in monorepo; delayed `resume` orchestration still app-specific |
| **MessageBus** | `InProcessMessageBus`, **`RedisMessageBus`** (`@opencoreagents/adapters-redis`), `UpstashRedisMessageBus` | BullMQ-as-transport for messages (alternative pattern) |
| **Bootstrap** | **`new AgentRuntime({ … })`** registers built-in tools (`system_save_memory`, `system_get_memory`) and optional vector / `system_send_message` handlers (same as constructor side effects) | — |
| **Direct engine API** | `buildEngineDeps`, `createRun`, `executeRun`, `getAgentDefinition` — same loop as `RunBuilder`; use when a job handler should not use `Agent.run` | You must call `runStore.save` after each `executeRun` when using `runStore` (including `waiting`) |

---

## 1. Architecture: per-process vs shared

```
┌──────────────────────────────────────────────────────────────────┐
│  Shared infrastructure (Redis / Upstash / Postgres / etc.)       │
│                                                                  │
│  ┌────────────┐  ┌────────────┐  ┌─────────────┐  ┌───────────┐│
│  │MemoryStore │  │  RunStore  │  │  Job Queue  │  │ MessageBus││
│  │(Redis) ✓   │  │(Redis) ✓   │  │(BullMQ) ○   │  │(Redis) ✓  ││
│  └────────────┘  └────────────┘  └─────────────┘  └───────────┘│
└──────────────────────────────────────────────────────────────────┘
         ▲                ▲                ▲               ▲
         │                │                │               │
   ╔═══════════╗   ╔═══════════╗   ╔═══════════╗
   ║  Worker 1 ║   ║  Worker 2 ║   ║  Worker N ║
   ║───────────║   ║───────────║   ║───────────║
   ║ Registry  ║   ║ Registry  ║   ║ Registry  ║   ← identical bootstrap
   ║ Runtime   ║   ║ Runtime   ║   ║ Runtime   ║   ← new AgentRuntime({ … })
   ║ Engine    ║   ║ Engine    ║   ║ Engine    ║   ← stateless per-run
   ║ Adapters  ║   ║ Adapters  ║   ║ Adapters  ║   ← point to shared infra
   ╚═══════════╝   ╚═══════════╝   ╚═══════════╝
```

Legend: **✓** = adapter(s) in repo. **○** = your app wires BullMQ (or another queue) around Redis — **`@opencoreagents/adapters-bullmq`** supplies typed helpers; queue infra is not implied by the diagram alone.

### 1.1 Per-process (replicated on every node)

| Component | Why per-process | Cluster requirement |
|-----------|----------------|---------------------|
| **Definition registry** (`registry.ts`) | Module-level `Map`s — tool, skill, and agent definitions | Every worker must end up with the **same** registered definitions. Usually that means identical `Tool.define` / `Skill.define` / `Agent.define` at startup. Alternatively, load **JSON** from Redis/DB and call **`Skill.define`** / **`Skill.defineBatch`** so each process fills its own `Map` — still no cross-process live sync of the `Map` itself. |
| **Runtime** (`AgentRuntime`) | One instance per worker (holds merged `EngineConfig`) | Each worker constructs **`new AgentRuntime({ llmAdapter, memoryAdapter, runStore?, … })`** at boot with the **same** adapter wiring. Pass that instance to **`Agent.load(..., runtime, …)`** and **`dispatchEngineJob(runtime, …)`**. |
| **Tool handlers** | Registered via `registerToolHandler` into a process-local `Map` | Each worker registers the same handler set. Handlers contain code (functions), not serializable. |
| **Engine loop** (`executeRun`) | Pure function: takes `Run` + `EngineDeps`, returns `Run` | Stateless — any worker can execute any run as long as it can read/write the `Run` from a shared store. |
| **Built-in tools** (`system_save_memory`, `system_get_memory`) | Registered when **`AgentRuntime`** is constructed | Same on every node — they delegate to the shared `MemoryAdapter`. |

**Key rule**: **tool handlers** stay in-process (functions). For **definitions**, either ship them in code (redeploy all workers when they change) or **hydrate from a store** on boot (and on invalidation) so every node registers the same metadata — or use **per-job** hydration (**`AgentRuntime.dynamicDefinitionsStore`** + **`dispatch`**, or **`hydrateAgentDefinitionsFromStore`**) as in [Dynamic runtime REST](./21-dynamic-runtime-rest.md). There is no magic replication of the module-level `Map`s — only identical bootstrap logic per worker. Skill JSON + code `execute`: [Definition syntax](./06-definition-syntax.md) §9.2b.

### 1.2 Shared (external infrastructure)

| Component | Implementation | Cluster role |
|-----------|---------------|-------------|
| **MemoryAdapter** | **`RedisMemoryAdapter`** (TCP, `@opencoreagents/adapters-redis`), `UpstashRedisMemoryAdapter` (REST), Postgres | All workers read/write the same memory store. `InMemoryMemoryAdapter` is **single-process only** (tests / local dev). |
| **RunStore** | `InMemoryRunStore` (tests/local), **`RedisRunStore`** (TCP, `@opencoreagents/adapters-redis`), `UpstashRunStore` (HTTP, `@opencoreagents/adapters-upstash`) | Persists `Run` so `wait` on node A can be `resume`d on node B. Pass **`runStore`** into **`AgentRuntime`** — see §3. |
| **Job queue** (BullMQ / QStash) | **`@opencoreagents/adapters-bullmq`** — typed queue/worker; **`dispatchEngineJob(runtime, payload)`** from **`core`** (re-exported) | Distributes `run` / `resume` jobs across workers. QStash remains app-integrated (not packaged here). |
| **MessageBus** | `InProcessMessageBus` (single process), **`RedisMessageBus`** (TCP Streams, `@opencoreagents/adapters-redis`), `UpstashRedisMessageBus` (REST) | Delivers `system_send_message` across workers when **`messageBus`** is set on **`AgentRuntime`**. |
| **VectorAdapter** | Upstash Vector | Shared semantic index — stateless queries from any node. |

---

## 2. Bootstrap contract (per worker)

Every worker process must execute this sequence before handling jobs:

```typescript
import { AgentRuntime, Agent, Tool, Skill } from "@opencoreagents/core";
import { OpenAILLMAdapter } from "@opencoreagents/adapters-openai";
import { RedisMemoryAdapter, RedisRunStore, RedisMessageBus } from "@opencoreagents/adapters-redis";
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL!);

// 1. Adapters pointing to shared infrastructure (built-in tools register in the AgentRuntime constructor).
// Prefer TCP Redis (`adapters-redis`) for the same connection style as BullMQ and typical production clusters.
const runtime = new AgentRuntime({
  llmAdapter: new OpenAILLMAdapter(process.env.OPENAI_API_KEY!),
  memoryAdapter: new RedisMemoryAdapter(redis),
  runStore: new RedisRunStore(redis), // required for wait/resume across workers
  messageBus: new RedisMessageBus(redis), // omit if you do not use system_send_message across processes
});

// Alternative — Upstash REST (no TCP): same contracts, HTTP client to Redis
// import { UpstashRedisMemoryAdapter, UpstashRunStore, UpstashRedisMessageBus } from "@opencoreagents/adapters-upstash";
// const redisUrl = process.env.UPSTASH_REDIS_URL!;
// const redisToken = process.env.UPSTASH_REDIS_TOKEN!;
// const runtime = new AgentRuntime({
//   llmAdapter: new OpenAILLMAdapter(process.env.OPENAI_API_KEY!),
//   memoryAdapter: new UpstashRedisMemoryAdapter(redisUrl, redisToken),
//   runStore: new UpstashRunStore(redisUrl, redisToken),
//   // messageBus: new UpstashRedisMessageBus(redisUrl, redisToken),
// });

// 2. Definitions — identical on every node (your domain tools/skills/agents only).
// Do NOT re-define built-ins: system_save_memory / system_get_memory are registered by AgentRuntime construction.
await Tool.define({
  id: "lookup_ticket",
  scope: "global",
  description: "Example custom tool",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  execute: async (input) => ({ ok: true }),
});
await Skill.define({ id: "intakeSummary", /* ... */ });
await Agent.define({ id: "ops-analyst", /* ... */ });

// 3. Pass `runtime` into Agent.load / dispatchEngineJob / HTTP handlers — see §4
```

If step 2 differs between workers, behavior is undefined: one node may refuse a tool another node allows.

---

## 3. RunStore

The engine keeps a `Run` in memory during `executeRun`. For clusters, **`RunBuilder` saves the run after each `executeRun` when `runStore` is set**, including when status is `waiting`, so another worker can call `Agent.resume`.

### 3.1 Interface (implemented in `@opencoreagents/core`)

```typescript
interface RunStore {
  save(run: Run): Promise<void>;
  saveIfStatus(run: Run, expectedStatus: RunStatus): Promise<boolean>;
  load(runId: string): Promise<Run | null>;
  delete(runId: string): Promise<void>;
  listByAgent(agentId: string, status?: RunStatus): Promise<Run[]>;
  listByAgentAndSession(
    projectId: string,
    agentId: string,
    sessionId: string,
    opts?: {
      tenantId?: string;
      status?: RunStatus;
      limit?: number;
      cursor?: string;
      order?: "asc" | "desc";
    }
  ): Promise<{ runs: Run[]; nextCursor?: string }>;
}
```

### 3.2 Implementations

| Impl | When |
|------|------|
| `InMemoryRunStore` | Tests, local dev, single-process |
| `UpstashRunStore` (`@opencoreagents/adapters-upstash`) | Production cluster — JSON per `run` in `run:data:{runId}` plus `run:agent:{agentId}` SET for listing |
| DB-backed | High-volume production with audit requirements (implement `RunStore` yourself) |

### 3.3 Integration points

- `Agent.run()` / `Agent.resume()` → `RunBuilder` persists after every `executeRun` when `runStore` is configured (including `status: waiting` so another worker can resume): unconditional **`save`** for the first write of a new run; **`saveIfStatus(..., "waiting")`** when resuming or continuing in-process after a **`waiting`** persist (see §3.4).
- **`buildEngineDeps` + `createRun` + `executeRun`** (no `RunBuilder`) → pass **`session.projectId`** as the fourth argument and optional **`session.tenantId`** as the sixth argument to **`createRun`** so stored runs match the session isolation scope; you must **`runStore.save(run)`** after each `executeRun` when `runStore` is set, same as `RunBuilder` (including `waiting`).
- `Agent.resume(runId, input)` → `runStore.load(runId)` (must be `waiting`), verifies exact **`projectId`** and optional **`tenantId`** match the current **`Session`**, injects a user `resumeMessages` turn, then `executeRun` continues the loop.
- On `completed` / `failed` → same save applies; optionally delete or archive in your app if you do not want long-term retention.

Pass **`runStore`** (and other adapters) in the **`AgentRuntime`** constructor alongside **`memoryAdapter`** and **`llmAdapter`**.

### 3.4 Concurrency and integrity (multi-worker)

- **`RunStore.saveIfStatus` (bundled adapters):** after **`resume`** and after in-process **`onWait`** when the run was last persisted as **`waiting`**, **`RunBuilder`** calls **`saveIfStatus(..., "waiting")`** so only one writer succeeds; the other gets **`RunInvalidStateError`**. **`RedisRunStore`** uses **`WATCH`/`MULTI`/`EXEC`**; **`UpstashRunStore`** uses one **`EVAL`** per commit. The **first** persist of a brand-new run still uses unconditional **`save`**. Prefer **BullMQ `jobId`** dedupe anyway to avoid wasted work.
- **Memory adapters (`Redis` / `Upstash`)** use **read–modify–write** for **`save`** (append to a JSON list). Concurrent **`system_save_memory`** for the **same** session + `memoryType` can **lose** updates. Use app-level serialization, **Lua** / **`WATCH`**, or list primitives if you need atomic append under load.
- **`EngineJobPayload`** (BullMQ) includes **`sessionId`**, **`projectId`**, optional **`tenantId`**, optional **`endUserId`**, and optional **`expiresAtMs`**. **`dispatchEngineJob`** forwards these into **`Session`** and throws **`EngineJobExpiredError`** if the job is processed after **`expiresAtMs`** — treat as **non-retryable** in BullMQ if appropriate. For B2B2C **`longTerm`** / **`vectorMemory`**, enqueue jobs with **`endUserId`** set when the run is on behalf of an end-user ([Multi-tenancy §4](./12-multi-tenancy.md)).

Full table: [`technical-debt-security-production.md` §2](../../roadmap/technical-debt-security-production.md#2-multi-worker-concurrency-and-integrity).

---

## 4. Job queue: cluster execution model (**BullMQ priority**)

The job queue is **not** inside `packages/core` — it is **infrastructure** that invokes the engine. **`@opencoreagents/adapters-bullmq`** provides typed **queue** / **worker** helpers. **`dispatchEngineJob(runtime, payload)`** is implemented in **`@opencoreagents/core`** and **re-exported** from **`adapters-bullmq`** for convenience; workers call the same **`Agent.run`** / **`Agent.resume`** path as the SDK. QStash is **not** packaged here; integrate HTTP callbacks in your app if needed.

```
┌────────────┐     ┌──────────────┐     ┌────────────┐
│ API / Webhook │──►│  Job Queue   │──►│  Worker    │
│ enqueues job  │   │  (BullMQ)    │   │  (engine)  │
└────────────┘     └──────────────┘     └────────────┘
```

### 4.1 BullMQ (primary) — `adapters-bullmq`

- **Package**: `createEngineQueue`, `createEngineWorker`, `DEFAULT_ENGINE_QUEUE_NAME`; **re-exports** `dispatchEngineJob` and typed **`EngineJobPayload`** from **`@opencoreagents/core`** (`kind: "run" | "resume"`; optional **`expiresAtMs`**).
- **Design**: one or more workers per queue, all running the same bootstrap (§2).
- Worker **processor** typically **`await dispatchEngineJob(runtime, job.data)`** after constructing **`AgentRuntime`** + definitions — or (low-level) `getAgentDefinition` + `buildEngineDeps(agent, session, runtime)` + **`createRun(..., session.projectId)`** / `executeRun` with `runStore.save` as in §3.3.
- Retries, backoff, dead-letter are BullMQ config — the engine sees a normal run.
- `wait` → worker completes the job (run is persisted in `RunStore`). A **delayed `addResume`** or **separate scheduled job** later processes `resume`.
- **Horizontal scaling**: add worker processes; BullMQ + Redis coordinate (see §7).

Minimal worker (same bootstrap as §2 — **`AgentRuntime`** + definitions before `Worker` starts):

```typescript
import { AgentRuntime } from "@opencoreagents/core";
import {
  DEFAULT_ENGINE_QUEUE_NAME,
  createEngineWorker,
  dispatchEngineJob,
} from "@opencoreagents/adapters-bullmq";
import type { Job } from "bullmq";

// connection: BullMQ `ConnectionOptions` — often `{ url: process.env.REDIS_URL }` for TCP Redis
const connection = { url: process.env.REDIS_URL! };

const runtime = new AgentRuntime({
  // llmAdapter, memoryAdapter, runStore, … — same object shape as §2
});

createEngineWorker(
  DEFAULT_ENGINE_QUEUE_NAME,
  connection,
  async (job: Job) => {
    await dispatchEngineJob(runtime, job.data);
  },
);
```

Enqueue from your API with **`createEngineQueue`** (`addRun` / `addResume`) using the same `queueName` and `connection`.

### 4.2 QStash (alternative) — planned integration

- **Design**: serverless — QStash POSTs to an HTTP endpoint (e.g. `/runs/:id/resume`) after a delay.
- The HTTP handler loads the run from `RunStore`, calls `agent.resume`, and responds.

---

## 5. MessageBus in cluster

| Mode | Scope | Implementation |
|------|-------|----------------|
| **In-process** | Single-process dev / tests | `InProcessMessageBus` (`@opencoreagents/core`) |
| **Redis Streams (TCP)** | Cluster (multiple workers) | `RedisMessageBus` (`@opencoreagents/adapters-redis`) — stream `bus:agent:{toAgentId}`, `XRANGE` polling in `waitFor`. |
| **Redis Streams (REST)** | Cluster (multiple workers) | `UpstashRedisMessageBus` (`@opencoreagents/adapters-upstash`) — same keys/semantics over HTTP. |
| **BullMQ-backed** | *Optional app pattern* | For **`run`/`resume` jobs**, use **`@opencoreagents/adapters-bullmq`** (§4). Using BullMQ **as transport for `system_send_message`** (instead of Redis Streams) is a custom design — not a separate package. |

In cluster mode, `system_send_message` from agent A (on worker 1) writes to Redis; agent B’s run (on worker 3) picks it up via `waitFor` when using `UpstashRedisMessageBus` or `RedisMessageBus`.

---

## 6. What breaks if you ignore this

| Scenario | Single process | Cluster without shared stores |
|----------|---------------|-------------------------------|
| `Agent.define` on deploy | Works | Each worker has its own copy — fine if all deploy the same code |
| `agent.run("hello")` | Works | Works — stateless execution |
| `wait` → `resume` | Works with in-memory `Run` if same process | **Breaks** without `RunStore` — `Run` lost when another worker must resume. |
| `system_save_memory` → `system_get_memory` | Works with `InMemoryMemoryAdapter` | **Breaks** — data in worker 1's heap. Needs shared Redis. |
| `system_send_message` (multi-agent) | Works with in-process bus | **Breaks** — in-process bus is per-process. Needs `UpstashRedisMessageBus`, `RedisMessageBus`, or equivalent shared bus. |
| Job retry after crash | No mechanism in engine | **You add** BullMQ (or equivalent) around `agent.run` / `agent.resume`. |

---

## 7. Recommended production stack

```
┌─────────────────────────────┐
│  Upstash Redis (REST)       │
│  *or* TCP Redis (adapters-  │
│  redis: memory/run/bus)     │
│  ├── MemoryAdapter          │
│  ├── RunStore               │
│  └── MessageBus (streams)    │
│                             │
│  Same Redis *or* separate   │
│  TCP Redis for BullMQ ○     │  ← your infrastructure (not in monorepo)
│                             │
│  Upstash Vector             │
│  └── VectorAdapter          │
├─────────────────────────────┤
│  N × Worker process         │
│  (identical code, same env) │
│  new AgentRuntime(…)       │
│  Tool/Skill/Agent.define(…) │
│  Your BullMQ Worker.on ○    │
└─────────────────────────────┘
```

Workers are stateless and horizontally scalable for **engine** execution. Add or remove workers without changing definitions.

### 7.1 TCP Redis vs Upstash REST vs BullMQ

| Use case | Typical connection | Notes |
|----------|-------------------|--------|
| **TCP Redis adapters** (`RedisMemoryAdapter`, `RedisRunStore`, `RedisMessageBus` in `@opencoreagents/adapters-redis`) | **TCP** (`ioredis`) | **Default for clusters:** same semantics as REST adapters; one `REDIS_URL` can back engine state **and** BullMQ workers. |
| **Upstash REST adapters** (`UpstashRedisMemoryAdapter`, `UpstashRunStore`, `UpstashRedisMessageBus`) | Upstash **REST** (`fetch` JSON command arrays) | No persistent TCP connection; good for serverless/edge; `MessageBus.waitFor` uses polling over HTTP. |
| **BullMQ** | **TCP** Redis (`ioredis` / `node-redis`) | Requires long-lived connection — **not** the REST-only Upstash client. Often the **same** TCP Redis as `@opencoreagents/adapters-redis`. |
| **Practical split** | One or two connections | Prefer **one TCP Redis** for `adapters-redis` + BullMQ; add **Upstash REST** only if you need HTTP-only access; add **Upstash Vector** for hosted vectors (can pair with either). |

You can run **Upstash Vector** with **Upstash Redis REST** for engine state and a **separate** TCP Redis for BullMQ — or consolidate on **TCP** for queues + `adapters-redis` and keep **only** `UpstashVectorAdapter` from `@opencoreagents/adapters-upstash`.

---

## 8. Graceful shutdown (workers)

When stopping a worker process (deploy, scale-down, SIGTERM):

1. **Stop accepting new jobs** — drain your HTTP server or pause BullMQ worker consumption (`worker.close()` in BullMQ) so no new `agent.run` starts.
2. **Wait for in-flight runs** — `executeRun` may still be running; use a shutdown timeout (e.g. 30–120s) and `AbortSignal` if you wire it through `RunBuilder` / engine in the future.
3. **Persist state** — with `runStore`, waiting runs are already saved after each step; completing workers should not lose `Run` state.
4. **Exit** — `process.exit(0)` after the drain timeout.

The engine does not ship a global run registry; **your** queue layer should track active jobs and await completion before exit.

---

## 9. Minimal deploy recipe (Docker Compose)

Example: two identical worker containers sharing Redis (TCP) for BullMQ *when you add it*, plus Redis/Upstash-compatible endpoints for adapters. This is a **skeleton** — replace image names and env with your registry.

```yaml
services:
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  worker-a:
    build: .
    environment:
      REDIS_URL: redis://redis:6379
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      UPSTASH_REDIS_URL: ${UPSTASH_REDIS_URL}
      UPSTASH_REDIS_TOKEN: ${UPSTASH_REDIS_TOKEN}
    command: ["node", "dist/worker.js"]
    deploy:
      replicas: 2
```

- **Two replicas** of the same image run the same bootstrap (§2); both construct **`AgentRuntime`** with shared Upstash URLs for `memoryAdapter`, `runStore`, and optionally `messageBus`.
- **BullMQ** (when you add it) would use `REDIS_URL` against `redis:6379` for the queue only, while Upstash remains for REST-backed adapters if you keep that split (§7.1).
- For **local-only** experiments, point all adapters at `redis:6379` only if you implement TCP Redis variants — the shipped Upstash adapters expect the **Upstash REST** URL format.

---

## 10. Relationship to other docs

| Doc | Connection |
|-----|------------|
| [Architecture](./02-architecture.md) | Component view — this doc adds the multi-process dimension. |
| [Adapters infrastructure](./13-adapters-infrastructure.md) | BullMQ / QStash as job queue; this doc explains cluster deployment and what is actually implemented. |
| [mvp.md](../../roadmap/mvp.md) | MVP scope: "distributed store for Agent.define" out of MVP — planning doc explains why it's acceptable. |
| [Multi-agent communication](./14-communication-multiagent.md) | MessageBus in-process vs Redis — this doc formalizes the cluster requirement. |
| [Multi-tenancy](./12-multi-tenancy.md) | `projectId` isolation applies identically across cluster workers. |
| [`../roadmap/scaffold.md`](../../roadmap/scaffold.md) | Implementation phases; RunStore / cluster support in the phase plan. |
