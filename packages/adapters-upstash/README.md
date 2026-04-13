# `@opencoreagents/adapters-upstash`

**Upstash REST** implementations for `@opencoreagents/core`: HTTP access to **Redis** (no long-lived TCP) plus **Upstash Vector** for RAG / `system_vector_search`.

Use this package when you want **serverless- or edge-friendly** `fetch`-only calls, or when you colocate **vector** with Upstash Redis in one dependency. For a normal **`REDIS_URL`** and the same key layout over TCP, prefer **`@opencoreagents/adapters-redis`** (`ioredis`) for memory, `RunStore`, and `MessageBus`.

## Exports

- `UpstashRedisMemoryAdapter` — `MemoryAdapter` (REST command arrays to Upstash Redis)
- `UpstashRunStore` — durable `Run` JSON for `wait` / `resume` across workers
- `UpstashRedisMessageBus` — Redis Streams via REST (`system_send_message` across processes)
- `UpstashVectorAdapter` — `VectorAdapter` for semantic search / upserts

## Docs

- [06-adapters-infrastructure.md](../../docs/core/06-adapters-infrastructure.md) (Upstash REST + vector)
- [17-rag-pipeline.md](../../docs/core/17-rag-pipeline.md) (vector tools)
- [19-cluster-deployment.md](../../docs/core/19-cluster-deployment.md)
