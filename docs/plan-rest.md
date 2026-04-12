# REST API planning

> Roadmap for an **HTTP/JSON** layer that exposes **`run` / `resume` / memory / logs / inter-agent send** with the same semantics as the SDK. There is **no full product REST server** in this monorepo yet — [`examples/dynamic-runtime-rest/`](../examples/dynamic-runtime-rest/) is a **partial** reference (see below). Sources: [`brainstorm/07-multi-agente-rest-sesiones.md`](./brainstorm/07-multi-agente-rest-sesiones.md) §REST, [`core/14-consumers.md`](./core/14-consumers.md) §REST API.

## What this document is (and is not)

| Concept | Meaning |
|---------|---------|
| **This file** | A **product / architecture spec** (routes, phases, constraints). It is **not** an npm package and does **not** fix a single repo path until you implement it. |
| **What you build** | A **BFF or API service** (your process) that handles HTTP, auth, tenancy, and calls **`@opencoreagents/core`** (+ optional **`@opencoreagents/adapters-bullmq`**, **`RunStore`**, etc.). Same engine as the SDK; different **transport**. |
| **Monorepo today** | **`packages/core`** = engine. **`@opencoreagents/rest-api`** mounts **plan-rest-shaped** routes on Express after **`Agent.define`**. See **Easiest HTTP server (today)** below. |

**Non-goals:** Putting business auth, rate limits, or multi-region deployment **inside** `packages/core` — those stay in the API service. The service constructs **`AgentRuntime`**, then **`Agent.load(agentId, runtime, { session })`**, **`RunBuilder`** (or worker pattern from [`19-cluster-deployment.md`](./core/19-cluster-deployment.md)).

---

## Current state (repository)

| Area | Status |
|------|--------|
| **Reference HTTP server** | **Partial** — [`@opencoreagents/rest-api`](../packages/rest-api/) + [`examples/plan-rest-express/`](../examples/plan-rest-express/) (**`GET /agents`**, **`POST /agents/:id/run`**, `resume`, `GET /runs`); [`examples/dynamic-runtime-rest/`](../examples/dynamic-runtime-rest/) (definitions CRUD + BullMQ). Memory / inter-agent HTTP routes from the target table are still host-owned — [`technical-debt.md`](./technical-debt.md) §5. |
| **Dynamic definitions** | **Shipped** — [`@opencoreagents/dynamic-definitions`](../packages/dynamic-definitions/), [`docs/core/21-dynamic-runtime-rest.md`](./core/21-dynamic-runtime-rest.md). |
| **Patterns** | **Documented** — cluster, BullMQ, QStash alternatives in `docs/core/`. |

**Note — `dynamic-runtime-rest` vs this plan:** Purposes differ, but the example is a **practical starting point** for the **infrastructure** a product REST layer would reuse: **`AgentRuntime`** on a BullMQ worker, **`runtime.dispatch` / `dispatchEngineJob`** with **`EngineJobPayload`** (session fields in the job), **202 + job poll** (and optional blocking `wait`) matching phase **R2**, and **Redis-backed dynamic definitions** ([`core/21-dynamic-runtime-rest.md`](./core/21-dynamic-runtime-rest.md)). It does **not** implement the **target routes** here (`POST /agents/:id/run`, `resume`, memory, `GET /runs/:runId`, inter-agent HTTP): those would be a **BFF-shaped router** on top of the same queue + payload types, mapping public URLs to `addRun` / `addResume` and (where needed) **`RunStore`** for run-centric reads — without replacing the engine loop.

### REST without dynamic definitions

The **target routes** below are **orthogonal** to [`@opencoreagents/dynamic-definitions`](../packages/dynamic-definitions/). For **code-only** agents:

- Workers (or an inline server) call **`Agent.define` / `Skill.define` / `Tool.define`** at **bootstrap** (or load generated definitions from your app bundle).
- **`AgentRuntime`** **without** `dynamicDefinitionsStore`: **`dispatch`** / **`dispatchEngineJob`** still builds **`Session`** from the job and runs **`Agent.load(agentId, …)`** — the **`agentId` must exist** in the in-process registry from that bootstrap.
- **`GET /agents`** can list ids from **config**, a **DB**, or whatever metadata you maintain; it does **not** require Redis definition hashes.
- You **omit** definition CRUD routes entirely; the REST surface is only **run / resume / runs / memory / send** (as needed).

Dynamic definitions add **optional** control-plane routes (like the example’s `/v1/agents` PUT + snapshot) and **per-job hydrate**; they are not a prerequisite for a product REST API.

---

## Delivery shape (how it becomes runnable code)

The spec does not mandate one layout; pick one (or evolve):

| Shape | What you ship | How operators run it |
|--------|----------------|----------------------|
| **A — Example / app in repo** | e.g. `examples/product-rest/` with `src/server.ts` | `pnpm start`; document **`PORT`**, **`REDIS_URL`**, API key in README. |
| **B — Publishable package (library)** | e.g. `packages/rest` exporting **`createRestRouter(deps)`** or **`createRestApp(options)`** | Consumer does `import { createRestApp } from '…'` and `app.listen(process.env.PORT)`. |
| **B′ — Package + CLI binary** | Same package with **`bin`** in `package.json` | `npx @opencoreagents/… serve` or `pnpm exec … serve` reads env and listens (closest to “run on a port with a secret” without writing `main.ts`). |
| **C — Extend `@opencoreagents/cli`** | New subcommand e.g. **`rest serve`** (see [`plan-cli.md`](./plan-cli.md)) | Single entrypoint for scaffold + optional local server — **product choice**; not required for the REST spec itself. |

**Typical environment (illustrative, host-owned):**

| Variable | Role |
|----------|------|
| **`PORT`** | HTTP listen port. |
| **`REDIS_URL`** | Shared Redis for **`RunStore`**, BullMQ, and/or memory — if used. |
| **`REST_API_KEY`** (or similar) | If you enforce **API key** auth: middleware in **your** server compares `Authorization: Bearer …` or `X-Api-Key` to env — **not** implemented in `core`. |
| **`ENGINE_QUEUE_NAME`** | When using **R2** async: same name for API producer and worker. |

Idempotency, JWT, mTLS, and rate limits stay in the same BFF layer.

### Easiest HTTP server (today)

There is **no** single `createAgentServer()` helper in `packages/core` (and **should not** be — HTTP stays in your BFF). The **fastest** ways to get a working JSON API in this repo:

| Goal | Start from | Notes |
|------|------------|--------|
| **Plugin**: **`Agent.define`** then **`app.use(createPlanRestRouter({ … }))`** — **`GET /agents`**, **`POST /agents/:id/run`**, **`resume`**, **`GET /runs/:id`**, optional **`dispatch`** (**202** + **`GET /jobs/:id`**) | [`@opencoreagents/rest-api`](../packages/rest-api/) + [`examples/plan-rest-express/`](../examples/plan-rest-express/) | **Inline** or **BullMQ** (same enqueue as **`dynamic-runtime-rest`**); optional **`apiKey`**; **multi-project** tenant headers/query/body. |
| **One process**, `Agent.run` / `resume` **inside the request**, `RunStore`, optional **SSE**, **`API_KEY`**, static UI | [`examples/real-world-with-express/`](../examples/real-world-with-express/) | Routes are **`/v1/chat`**, **`/v1/runs/…`**, not the **`/agents/:id/run`** names in the table below — same **engine** pattern. Good **BFF template**. |
| **API returns 202** + **BullMQ worker** runs **`dispatch`**, optional **Redis dynamic definitions** | [`examples/dynamic-runtime-rest/`](../examples/dynamic-runtime-rest/) | Matches **R2** async; map your public URLs to `addRun` / `addResume` to align with **`POST /agents/:id/run`** mentally. |
| **Smallest** loop only (no HTTP yet) | [`examples/minimal-run/`](../examples/minimal-run/) | Wrap `Session` → `load` → `run` in `express.post` to sketch **`POST /agents/:id/run`**. |

**Shared router:** **`@opencoreagents/rest-api`** exports **`createPlanRestRouter`**: **inline** **`run` / `resume`** via **`runtime`**, or **BullMQ** via **`dispatch: { engine, queueEvents?, … }`** (same **`addRun` / `addResume`** payload as **`dynamic-runtime-rest`** — **202** + **`GET …/jobs/:jobId`**, optional **`?wait=1`**). Also: fixed or per-request **`projectId`**, **`allowedProjectIds`**, **`agentIds`**, **`apiKey`**, **`resolveProjectId`**. See [`packages/rest-api/README.md`](../packages/rest-api/README.md). A future CLI **`serve`** is optional (**Delivery shape**).

**HTTPS (TLS):** terminate TLS at a **reverse proxy** (nginx, Caddy, cloud ingress) in production; for local HTTPS use **mkcert** + Node `https` or a dev proxy — not part of the engine.

---

## Target API shape (evolving, from brainstorm `07`)

| Method | Endpoint | Role |
|--------|----------|------|
| `GET` | `/agents` | List agent ids / metadata available to the caller’s tenant. |
| `POST` | `/agents/:id/run` | Body: user input + optional **`sessionId`**, **`endUserId`**, **`expiresAtMs`** (maps to `Session`). Returns `runId`, initial status, or async job id if enqueueing. |
| `POST` | `/agents/:id/resume` | Body: `runId` + resume payload (same contract as `Agent.resume`). |
| `GET` | `/agents/:id/memory` | Query scoped memory (design: session vs end-user — align with [`15-multi-tenancy.md`](./core/15-multi-tenancy.md)). |
| `GET` | `/runs/:runId` or `/agents/:id/logs` | Run history / status for debugging or dashboards. |
| `POST` | `/agents/:from/send` or bus-specific route | Multi-agent message to another agent (same as `system_send_message` semantics). |

**Cross-cutting:** Authentication (API key, JWT, mTLS), **`SecurityContext`** construction, **`SessionExpiredError`** → HTTP **401/403/440** (product choice), idempotency keys for `POST run` if jobs are retried.

---

## Phased plan

| Phase | Goal | Gate |
|-------|------|------|
| **R0 — Contract** | OpenAPI or markdown request/response schemas; error model mapping **`EngineError.code`** → HTTP status + JSON body. | Reviewed; matches `Run`, `RunStatus`, resume payload types in [`protocol`](../packages/core/src/protocol/types.ts). |
| **R1 — Minimal server** | Single-tenant demo: `POST run`, `POST resume`, `GET run` by id (in-memory or **`RedisRunStore`**). | Docker-compose or script; integration tests against real HTTP (or test harness). |
| **R2 — Async** | Optional **202** + job id when using **BullMQ** / worker; poll or webhook for completion — reuse [`adapters-bullmq`](../packages/adapters-bullmq/) patterns. | Documented flow in `19-cluster-deployment` or this file. |
| **R3 — Multi-tenant** | `projectId` / org resolution, memory routes scoped per [`15-multi-tenancy.md`](./core/15-multi-tenancy.md). | Security review; no cross-tenant `runId` leakage. |
| **R4 — Streaming (optional)** | SSE or chunked JSON for hook events (`onThought`, …) — does not replace core loop; transport only. | Load test + backpressure story. |

---

## Relationship to MCP and CLI

- **MCP**: Often implemented as a thin layer **on top of** this REST surface ([`plan-mcp.md`](./plan-mcp.md)) so there is one backend contract.
- **CLI** ([`plan-cli.md`](./plan-cli.md)): today focused on **scaffold** (`init`, `generate`, …). A future **`rest serve`** (or similar) could live under **`@opencoreagents/cli`** **or** as the **`bin`** of a dedicated REST package (**Delivery shape** above) — whichever matches release and DX goals. The CLI is **not** required for the REST contract to exist; any HTTP server that maps routes to **`AgentRuntime` / `dispatch` / `RunStore`** satisfies the intent.

---

## References

- [`brainstorm/07-multi-agente-rest-sesiones.md`](./brainstorm/07-multi-agente-rest-sesiones.md)
- [`core/14-consumers.md`](./core/14-consumers.md)
- [`packages/rest-api/`](../packages/rest-api/) — **`@opencoreagents/rest-api`**, **`createPlanRestRouter`**
- [`examples/plan-rest-express/`](../examples/plan-rest-express/) — minimal Express server using the package
- [`examples/real-world-with-express/`](../examples/real-world-with-express/) — Express BFF + `RunStore` (sync HTTP pattern)
- [`examples/dynamic-runtime-rest/`](../examples/dynamic-runtime-rest/) — BullMQ + `dispatch` (async HTTP pattern)
- [`examples/README.md`](../examples/README.md) — full example index
- [`plan.md`](./plan.md) — engine snapshot
- Cluster + queues: [`core/19-cluster-deployment.md`](./core/19-cluster-deployment.md)
