# Engine MVP and risks

Planning doc: **minimum engine scope**, adapter choices for an MVP rollout, risks, and suggested build order. **Normative contracts** stay in [`docs/reference/core/`](../reference/core/README.md) — especially [05-adapters-contracts.md](../reference/core/05-adapters-contracts.md) and [13-adapters-infrastructure.md](../reference/core/13-adapters-infrastructure.md).

Related: [../core/02-architecture.md](../reference/core/02-architecture.md) (components), [../core/06-definition-syntax.md](../reference/core/06-definition-syntax.md) (`.define` + bootstrap), [../core/16-cluster-deployment.md](../reference/core/16-cluster-deployment.md) (**`AgentRuntime`**, **RunStore**, adapters).

## Minimum core scope

- One reference **Agent** with system prompt + closed tool list.
- **AgentExecution** with loop, **iteration limit**, validated LLM output as **JSON**.
- Minimal **MemoryAdapter**: in-memory + optional persistent adapter (`save` / `query` for long-term or working).
- **ToolRunner** with at least: `system_save_memory`, `system_get_memory` (or equivalent).
- States: **running**, **waiting**, **completed**, **failed** + **resume** after `wait` (in-process or via **`RunStore`** when another worker handles the next request — [16-cluster-deployment.md §3](../reference/core/16-cluster-deployment.md)).
- Basic **hooks** at the run boundary (thought / action / observation / wait).

## Persistent adapters in MVP

Production deployments use **adapters** that satisfy the same core interfaces ([05-adapters-contracts.md](../reference/core/05-adapters-contracts.md)); the engine loop does not change.

| Adapter / tool | MVP role |
|----------------|----------|
| **TCP Redis (`@opencoreagents/adapters-redis`)** | **Default** for clusters: `RedisMemoryAdapter`, `RedisRunStore`, `RedisMessageBus` on `REDIS_URL` — aligns with BullMQ and typical `redis://` infrastructure. |
| **Upstash REST (`@opencoreagents/adapters-upstash`)** | HTTP Redis + **`UpstashVectorAdapter`** when you want serverless/edge-friendly access or to colocate vector with Upstash Redis in one package. |
| **`@opencoreagents/adapters-bullmq` (priority)** | Typed **`createEngineQueue`** / **`createEngineWorker`**; **`dispatchEngineJob`** implemented in **`@opencoreagents/core`** and re-exported here — async `run` / `resume`, delayed jobs after `wait` (`reason: scheduled`); same engine API as SDK/REST — [13-adapters-infrastructure.md § Job queue](../reference/core/13-adapters-infrastructure.md#job-queue-adapter-primary-bullmq). |
| **Upstash QStash (alternative)** | If you skip BullMQ workers: HTTP callback to `POST /runs/:id/resume` (or internal equivalent) after a delay — serverless-friendly; **secondary** to BullMQ for the same semantics. |
| **Upstash Vector (optional MVP+)** | Tool `system_vector_search` / `system_vector_upsert` or subset: embeddings + query for semantic memory; can ship in the same phase as MVP if the use case requires it. |

### Upstash adapters in MVP

**Upstash REST** fits MVP when you need HTTP Redis (no long-lived TCP), want **`UpstashVectorAdapter`** in the same package, or deploy in serverless/edge-heavy environments. Treat **BullMQ** as the primary path for **async `run` / `resume`** and **scheduled `wait`**; use **QStash** only when you explicitly choose HTTP callbacks instead of Redis workers. Criteria and shared-key risks align with the **Persistent adapters in MVP** table above and [Risks and mitigation](#risks-and-mitigation).

Criteria to count them “inside MVP”:

- **Minimum viable cloud**: a **Redis-backed** `MemoryAdapter` (TCP or REST) + same `system_save_memory` / `system_get_memory` tools (registered when **`AgentRuntime`** is constructed — do not hand-roll unless replacing defaults).
- **Cluster `wait` / `resume`**: add **`runStore`** (**`RedisRunStore`** or **`UpstashRunStore`**) to **`AgentRuntime`** so a **waiting** run can be loaded and continued on any worker.
- **No core coupling**: credentials and keyspace prefixes only in the adapter factory, not in `AgentExecution`.

## Out of engine MVP

- Visual builder.
- **Product**-level “edit all definitions in a UI with no redeploy” (orchestration and auth around your DB) — out of **engine** MVP; the core already supports **JSON skill rows** + **`Skill.define` / `defineBatch`** with code **`execute`** ([06-definition-syntax.md §9.2b](../reference/core/06-definition-syntax.md)).
- MCP as a hard requirement.
- Complex semantic vector without real need (if you do not use Upstash Vector in MVP+).
- Complex multi-agent parallelism.

## Success criteria

- The agent **remembers** across executions with a local adapter, **TCP Redis** (`adapters-redis`), or **Upstash REST** (`adapters-upstash`).
- A run can **pause** (`wait`) and **continue** with new input (**`RunStore`** when resume is not guaranteed on the same process).
- Tools run only after a **validated action** from the engine.
- Same behavior whether the caller is **SDK** or **HTTP** (same internal API).

## Risks and mitigation

| Risk | Mitigation |
|------|------------|
| Long or infinite loops | `maxIterations`, global run timeout. |
| Malformed or hallucinated JSON | Strict schema/parser; bounded correction retries. |
| Inconsistent state | Snapshot per `runId` when entering `waiting`; do not mutate history. |
| Dangerous tools | Allowlist, per-tool validation, sandbox or network limits. |
| Shared Redis / Upstash limits | Namespaces by `projectId`/`agentId`, TTL, rate limits, payload size in memory. |

## Suggested implementation order

Detailed contracts: [07-llm-adapter.md](../reference/core/07-llm-adapter.md), [08-context-builder.md](../reference/core/08-context-builder.md), [09-skills.md](../reference/core/09-skills.md), [10-errors-parsing-and-recovery.md](../reference/core/10-errors-parsing-and-recovery.md).

1. LLM Adapter + parsing a single step type (`result` or `action`).
2. ToolRunner + minimal memory (in-memory or file).
3. Full loop + `wait` / `resume`; wire **`RunStore`** before relying on cross-worker resume.
4. **Redis MemoryAdapter** — `@opencoreagents/adapters-redis` (TCP) or `@opencoreagents/adapters-upstash` (REST); same interface; key idempotency tests.
5. Hooks + hardening (timeouts, limits).
6. **BullMQ** workers for background `run` / `resume` and scheduled `wait` (or **QStash** only if you explicitly choose the HTTP-callback path).
7. (Optional MVP+) Vector search/upsert.
