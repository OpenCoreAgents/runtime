# `@opencoreagents/adapters-redis`

TCP Redis (`ioredis`) implementations of **`MemoryAdapter`**, **`RunStore`**, **`MessageBus`**, and **`RedisDynamicDefinitionsStore`** ( **`DynamicDefinitionsStore`** facade: **`store.methods`** + **`store.Agent` / `Skill` / `HttpTool`**) for `@opencoreagents/core` / `@opencoreagents/dynamic-definitions`.

Use a single **`REDIS_URL`** / `redis://` connection for shared memory, persisted runs (`wait` / `resume` across workers), and **`system_send_message`** over Redis Streams — the same key and stream layout as `@opencoreagents/adapters-upstash`, so you can swap between TCP and Upstash REST without changing engine code.

**Vector** search is not included; use `@opencoreagents/adapters-upstash` (`UpstashVectorAdapter`) or another `VectorAdapter` for embeddings/RAG.

## Exports

- `RedisMemoryAdapter`
- `RedisRunStore`
- `RedisMessageBus`
- `RedisDynamicDefinitionsStore` — HASH keys `{prefix}:{projectId}:httpTools|skills|agents` (field = id, value = JSON). Use **`store.methods`** for raw reads/writes; **`hydrateAgentDefinitionsFromStore`** accepts the facade or **`store.methods`**. Workers often pass the facade to **`AgentRuntime.dynamicDefinitionsStore`** so **`dispatch`** hydrates per job.
- `memoryKeyPrefix` (key helper; matches Upstash memory key semantics)

## Docs

- [06-adapters-infrastructure.md](../../docs/core/06-adapters-infrastructure.md) (TCP Redis package)
- [19-cluster-deployment.md](../../docs/core/19-cluster-deployment.md)
