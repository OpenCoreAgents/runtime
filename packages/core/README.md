# `@opencoreagents/core`

Stateful agent **engine**: `Agent`, `AgentRuntime`, `Tool` / `Skill` / `Agent.define`, `RunBuilder`, `executeRun`, protocol loop (`thought` → `action` → `observation` → `result`, `wait` / `resume`), built-in tools, and **`dispatchEngineJob`** / **`AgentRuntime.dispatch`** for queue workers.

Sessions carry the required `projectId`, optional `tenantId` sub-scope for run isolation, optional expiry via `expiresAtMs`, and renewal helpers like `session.withExpiresAt(...)` and `session.extendBy(ttlMs)`.

## Related docs

Canonical engine index: [`docs/reference/core/README.md`](../../docs/reference/core/README.md).
