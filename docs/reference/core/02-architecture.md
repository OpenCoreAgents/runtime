# Internal engine architecture

Each worker process constructs **`new AgentRuntime({ … })`** at boot (adapters, built-in tools, optional **`runStore`** / **`messageBus`**) and passes that instance into **`Agent.load`** / job dispatch — see [Cluster deployment §2](./16-cluster-deployment.md). Definitions (**`Tool.define`**, **`Skill.define`** / **`defineBatch`**, **`Agent.define`**) fill the in-process registry; skills may also be hydrated from JSON ([Definition syntax §9.2b](./06-definition-syntax.md)). **Production:** auth and tenant isolation live **outside** the engine package — [Scope and security §7](./11-scope-and-security.md), [`technical-debt-security-production.md`](../../roadmap/technical-debt-security-production.md) §1–§3.

## Component view

All external entry should pass through the **SecurityLayer** first (see [Scope and security](./11-scope-and-security.md)).

```
                    ┌───────────────────┐
  input (run) ────► │  SecurityLayer    │
                    │  (authN / authZ)  │
                    └─────────┬─────────┘
                              │
                              ▼
                    ┌─────────────┐
                    │   Engine    │
                    │ (orchestr.) │
                    └──────┬──────┘
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
    ┌────────────┐  ┌────────────┐  ┌────────────┐
    │  Context   │  │ LLM        │  │ ToolRunner │
    │  Builder   │  │ Adapter    │  │ (+registry)│
    └────────────┘  └────────────┘  └─────┬──────┘
           │               │               │
           │               │               ▼
           │               │        Tool adapters
           ▼               │
    Memory (via           │
    MemoryAdapter) ◄───────┘
           │
           ▼
    RunStore (optional): persisted run state for wait / resume — required for cross-worker resume
```

## Responsibilities

| Piece | Responsibility |
|-------|----------------|
| **Context Builder** | Assemble what the model “sees”: system, input, memory (short / long / working), catalog of available tools/skills. Detail: [Context builder](./08-context-builder.md). |
| **LLM Adapter** | A uniform call; no agent business logic. Detail: [LLM adapter](./07-llm-adapter.md). |
| **Engine (loop)** | Interpret LLM output (e.g. JSON), branch: `thought` / `action` / `wait` / `result`, apply limits and validation. Errors and parsing: [Errors, parsing, and recovery](./10-errors-parsing-and-recovery.md). |
| **ToolRunner** | Resolve tool name → adapter; `validate?` → `execute` → return observation to history. |
| **Memory** | Accessed only via **MemoryAdapter** (or tools that use it); the engine core does not couple to Mongo/Redis. |
| **Run / AgentExecution** | In-process `runId`, `status`, `history`, `state` for the loop, **wait**/**resume**, and debugging. |
| **RunStore** | When **`runStore`** is set on **`AgentRuntime`**, persists **`Run`** so a **waiting** run can be **resumed** on another worker. Omit for single-process or in-memory tests. [Cluster deployment §3](./16-cluster-deployment.md). |
| **SecurityLayer** | Validates identity and permissions; attaches `SecurityContext` to the run; does not execute tools. |
| **Scope** | `projectId`, `sessionId`, and global vs project resolution for definitions and memory (see doc 08). |

## Suggested modules (implementation)

| Module | Typical contents |
|--------|------------------|
| `Agent` | Static or loaded definition: id, system prompt, skills/tools lists, memory config. |
| `AgentExecution` | A run instance: loop, outward hooks, intermediate state persistence. |
| `Skills` | Resolve skills referenced by the agent (declarative grouping, optional **`execute`**, store JSON + code map for hybrid loads). See [Skills](./09-skills.md). |
| `LLMAdapter` | OpenAI, Anthropic, etc. Contract in [LLM adapter](./07-llm-adapter.md). |
| `ToolRunner` | Registry `name → ToolAdapter`. |

**CLI** and **REST API** are **clients** of the same engine; they do not duplicate loop logic. Other consumers: [Consumers](./15-consumers.md). Multi-process / cluster deployment model: [Cluster deployment](./16-cluster-deployment.md).

## Data flow (summary)

1. `run(input)` creates or reuses session context per policy.
2. Context Builder reads memory via adapter.
3. LLM Adapter generates (ideally JSON with step type).
4. Engine applies state transitions and side effects (tools, memory, wait).
5. Until `result`, `failed`, or **`waiting`** — if **`runStore`** is configured, persist the run so **`resume`** can continue later (same or another worker). [Execution model](./03-execution-model.md), [Cluster deployment](./16-cluster-deployment.md).
