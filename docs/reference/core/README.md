# Core: Agent Engine

Status: stable  
Audience: contributors, maintainers

**Condensed** documentation for the **execution engine** (stateful runtime): what it does, how it is structured, lifecycle, internal protocol, and adapter contracts. **Consumer** types (CLI, REST, MCP, …) at a high level only: [Consumers](./15-consumers.md).

## Implementation status

The monorepo implements the engine, adapters (**OpenAI** and **Anthropic**; **TCP Redis** via `@opencoreagents/adapters-redis` as the **default** path for shared memory / RunStore / MessageBus; **Upstash REST** in `@opencoreagents/adapters-upstash` for HTTP-only Redis and **`UpstashVectorAdapter`**; **JSON-configured outbound HTTP tools** via **`@opencoreagents/adapters-http-tool`** — [HTTP tool adapter](./20-http-tool-adapter.md); **definition store + CRUD facade** (**`DynamicDefinitionsStore`**: **`store.methods`** + **`store.Agent`**, …) via **`@opencoreagents/dynamic-definitions`** — [Dynamic runtime](./21-dynamic-runtime-rest.md)), an Express JSON router (**`@opencoreagents/rest-api`**, **`createRuntimeRestRouter`**, contract in [REST plan](../../roadmap/plan-rest.md)) — [Consumers §REST](./15-consumers.md), **`@opencoreagents/conversation-gateway`** for inbound message normalization, **BullMQ-first** background execution via **`@opencoreagents/adapters-bullmq`** (typed queue/worker; **`dispatchEngineJob(runtime, payload)`** is implemented in **`@opencoreagents/core`** and re-exported from **`adapters-bullmq`** — see [Adapters infrastructure](./13-adapters-infrastructure.md#job-queue-adapter-primary-bullmq)), RAG tools + **per-project file catalog** on **`AgentRuntime`**, multi-agent messaging, CLI/scaffold, **`RunStore`** for cluster **`wait`/`resume`**, optional **per-tool timeouts** and **session expiry** on **`AgentRuntime`** / **`Session`** (`toolTimeoutMs`, `SessionOptions.expiresAtMs`), and the **direct worker API** (`buildEngineDeps`, `createRun`, `executeRun`). **CI:** GitHub Actions runs **`pnpm turbo run build test lint`** with **Redis** + **`REDIS_INTEGRATION=1`** for BullMQ integration (see [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml)); **`packages/core/tests`** covers hooks, multi-agent, memory scope, parse recovery, RAG catalog, vector caps, system_send_message policy, and related integration paths — see [Implementation plan progress snapshot](../../roadmap/plan.md). Cluster + queue patterns: [Cluster deployment](./16-cluster-deployment.md). Gaps and deferrals: [Technical debt](../../roadmap/technical-debt.md).

## Contents

**MVP scope and risks (planning):** [`mvp.md`](../../roadmap/mvp.md).

### Foundations

| Doc | Topic |
|-----|--------|
| [Purpose](./01-purpose.md) | Engine purpose, boundaries, layers (LLM vs engine) |
| [Architecture](./02-architecture.md) | Internal components and responsibilities |

### Runtime loop

| Doc | Topic |
|-----|--------|
| [Execution model](./03-execution-model.md) | Run, states, loop, wait/resume, **RunStore** |
| [Protocol](./04-protocol.md) | Messages, envelope, engine rules, durable **waiting** |

### Contracts and definitions

| Doc | Topic |
|-----|--------|
| [Adapters contracts](./05-adapters-contracts.md) | **MemoryAdapter**, **ToolAdapter**, **RunStore**; hooks vs adapters; multi-agent note; **`adapters-http-tool`**; **`dynamic-definitions`** (pointers to 20 / 21) |
| [Definition syntax](./06-definition-syntax.md) | JSON + library `Tool.define` / `Skill.define` / `defineBatch` / `Agent.define`, `SkillDefinitionPersisted`, `load`, `run` |
| [LLM adapter](./07-llm-adapter.md) | **LLMAdapter** contract; wiring via **`AgentRuntime`** (`llmAdapter` / `llmAdaptersByProvider`) |
| [Context builder](./08-context-builder.md) | Prompt ordering, truncation, **effectiveToolAllowlist** (registry ∩ agent/skills); **SecurityContext** not applied to prompt tools yet ([Scope and security](./11-scope-and-security.md) §2), **Step** shape |
| [Skills](./09-skills.md) | **Skills** vs **tools**, resolution, **`defineBatch`**, optional `execute`, store JSON |
| [Errors, parsing, and recovery](./10-errors-parsing-and-recovery.md) | Failures, **abort/timeout**, error taxonomy, parsing and **re-prompt** for `Step` |

### Security and tenancy

| Doc | Topic |
|-----|--------|
| [Scope and security](./11-scope-and-security.md) | Scope, **SecurityLayer**, **§7 production checklist**, [Security technical debt](../../roadmap/technical-debt-security-production.md) §1–§3 |
| [Multi-tenancy](./12-multi-tenancy.md) | **Multi-tenancy**: organizations, projects, end-users, memory scoping |

### Distributed and integration

| Doc | Topic |
|-----|--------|
| [Adapters infrastructure](./13-adapters-infrastructure.md) | **BullMQ** (primary), **QStash**; **`adapters-redis`** (TCP); **Upstash REST** + vector |
| [Multi-agent communication](./14-communication-multiagent.md) | **MessageBus** + **`AgentRuntime`**, `system_send_message`, `wait`/`resume` across agents |
| [Consumers](./15-consumers.md) | Engine **consumers**: SDK, BullMQ, CLI, REST, MCP; **production** auth/tenant note |
| [Cluster deployment](./16-cluster-deployment.md) | **Cluster**: per-process vs shared, RunStore, MessageBus (**Redis TCP** preferred, Upstash REST optional), BullMQ/QStash (planned), horizontal scaling |

### Platform extensions

| Doc | Topic |
|-----|--------|
| [Utils](./17-utils.md) | **Utils**: parsers, chunking, file-resolver — internal utilities for tools |
| [RAG pipeline](./18-rag-pipeline.md) | **RAG pipeline**: EmbeddingAdapter, VectorAdapter, RAG tools, agent patterns |
| [Scaffold](./19-scaffold.md) | **Scaffold**: CLI `init` / `generate`, project templates, bootstrapping API |
| [HTTP tool adapter](./20-http-tool-adapter.md) | **HTTP tools from JSON**: `@opencoreagents/adapters-http-tool`, templates, `allowedHosts`, `registerHttpToolsFromDefinitions` |
| [Dynamic runtime REST](./21-dynamic-runtime-rest.md) | **Dynamic definitions**: `@opencoreagents/dynamic-definitions`, **`DynamicDefinitionsStore`** facade (**`store.methods`** + **`store.Agent` / `Skill` / `HttpTool`**), **`hydrateAgentDefinitionsFromStore`**, **`AgentRuntime.dynamicDefinitionsStore`** + **`dispatch`**, optional **`syncProjectDefinitionsToRegistry`**, example **`dynamic-runtime-rest`** |

## In one sentence

The **engine** builds context, calls the LLM, **interprets** outputs, **executes** tools via adapters, **persists** state/memory, and **controls** the loop (including the `wait` pause).

## Origin

Derived and reorganized from `docs/archive/brainstorm/` and the *Agentes AI* PDF thread.
