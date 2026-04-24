# Internal engine protocol

Related: [Execution model](./03-execution-model.md) (state machine, **wait**/**resume**), [Definition syntax](./06-definition-syntax.md) (full JSON shapes), [Cluster deployment](./16-cluster-deployment.md) (**RunStore** persistence).

Full **JSON shapes** (agent, run, `Step` steps, etc.) are in [Definition syntax](./06-definition-syntax.md).

## Principle

Every relevant exchange is a **typed message**. The LLM produces **proposals** in that format; the engine **validates** and **materializes** effects (tools, memory, state).

## Message types

```json
{
  "type": "thought | action | observation | wait | result",
  "content": "...",
  "meta": {}
}
```

| Type | Produced by | Meaning |
|------|-------------|---------|
| `thought` | LLM (via engine) | Intermediate reasoning; no mandatory side effect. |
| `action` | LLM | Intent: tool name + input. |
| `observation` | Engine / ToolRunner | Result of executing the tool. |
| `wait` | LLM | Pause until input or external event. |
| `result` | LLM | Final response to the caller. |

## Run envelope (traceability)

```json
{
  "id": "uuid",
  "agentId": "...",
  "messages": [],
  "state": {},
  "tools": [],
  "status": "running | waiting | completed | failed"
}
```

Useful for logs, debugging, and replaying reasoning. Match **`Run`** / **RunStore** payloads in code ([Execution model](./03-execution-model.md)); **`waiting`** implies a **resume** path (same process or shared **RunStore**).

## Action toward tools

Logical request (after parsing `action`):

```json
{
  "tool": "memory_search",
  "input": { "query": "open escalations this week" }
}
```

Response in history as `observation`:

```json
{
  "success": true,
  "data": []
}
```

## Prompt to the LLM

- System + structured messages (ordering and truncation: [Context builder](./08-context-builder.md)).
- List of available tools (names, schemas).
- Explicit instruction: **JSON** output parseable by the engine (type + required fields).
- If JSON fails: recovery and errors in [Errors, parsing, and recovery](./10-errors-parsing-and-recovery.md).

## Engine rules (invariants)

1. **The LLM does not execute tools**: it only proposes `action`; the **ToolRunner** executes.
2. **All side effects go through the engine**: permissions, limits, logging.
3. **History is immutable**: **append** only.
4. **Durable state** (business memory, **`waiting`** runs) lives **outside** the model’s volatile context: **MemoryAdapter** and, for cross-process **resume**, **RunStore** wired on **`AgentRuntime`**. The prompt reflects a **snapshot**, not the sole source of truth.

## Logical security

- Allowlist of tool names.
- Per-tool `input` validation (`validate?` on adapter).
- Reject actions if the run is `completed` or `failed`.

Authorization by **principal**, **project**, and scopes before the engine: [Scope and security](./11-scope-and-security.md).
