# Implementation proposal — Conversation Gateway (channel-agnostic)

**Brainstorm / implementation sketch.** How to encapsulate external integration without coupling the product to a specific vendor. Complements [`13-canales-mensajeria-integracion.md`](./13-canales-mensajeria-integracion.md) (problem and context) and consumers in [`../core/14-consumers.md`](../core/14-consumers.md).

---

## 1. Goal

A **single domain component** that:

- Accepts **already normalized** messages (no knowledge of vendor HTTP or proprietary formats).
- Resolves **`Session`** and chooses **`run`** vs **`resume`** from run state and product policy.
- Optionally **serializes** work per conversation (queue / lock).
- Emits **outbound** replies through a **decoupled port** (each implementation talks to the real API).

The **`AgentRuntime`** engine does not change: it is only invoked from this layer.

---

## 2. Recommended names (neutral)

| Role | Suggested name | Responsibility |
|------|----------------|----------------|
| Orchestrator | **`ConversationGateway`** or **`InboundMessageProcessor`** | Entry point after normalization; calls `Agent.load`, `run`, `resume`. |
| Outbound | **`OutboundDispatcher`** (interface) | `sendReply(conversationKey, payload)` — concrete implementations per transport. |
| Normalization | *Adapters* per source | Webhook / SDK → **`NormalizedInboundMessage`** (internal DTO). |

Avoid vendor- or single-channel-specific terms in the generic core.

---

## 3. Minimal contracts (conceptual)

### 3.1 Normalized inbound

**`NormalizedInboundMessage`** (illustrative name):

- **`conversationKey`**: stable string identifying the logical thread (1:1 or group), derived in your mapping layer.
- **`text`**: main turn content (extend later to `parts` if you add media).
- **`externalMessageId`**: provider id for **idempotency** (avoid double processing on webhook retries).
- **`receivedAt`**: instant (ISO or ms).
- **`metadata`**: optional `Record<string, unknown>` — for adapters only (not required by the gateway).

### 3.2 Session resolution

**`resolveSession(conversationKey)`** → `{ sessionId, projectId, … }` according to your model (table, deterministic hash, etc.).

### 3.3 Run vs resume routing

Example product rule:

- If there is a run in **`waiting`** for that **session** + target **agent** and you have persisted **`runId`** → **`agent.resume(runId, input)`**.
- Otherwise → **`agent.run(text)`** (new run).

The lookup can use a filtered **`RunStore`**, or an auxiliary table **`active_wait_by_session`** if you need more control.

### 3.4 Outbound

**`OutboundMessage`** (illustrative name):

- **`conversationKey`** (or ids already resolved by the outbound adapter).
- **`text`** or minimal agreed payload.
- Optional: **`runId`**, **`correlationId`** for tracing.

---

## 4. End-to-end flow

```
[Source adapter]  →  NormalizedInboundMessage
        ↓
[Optional queue / lock per conversationKey]
        ↓
ConversationGateway
        → resolveSession
        → run | resume  (Agent.load + engine)
        ↓
OutboundDispatcher  →  [Destination adapter]
```

- **HTTP webhook**: respond **quickly** (200) and enqueue if work is long; see [`13`](./13-canales-mensajeria-integracion.md) §4.

---

## 5. Concurrency per conversation

| Strategy | Use |
|----------|-----|
| **FIFO queue per `conversationKey`** | One consumer processes one message at a time per thread; avoids overlapping `run()` on the same session. |
| **Distributed lock** (e.g. Redis `SET key NX EX …`) | Lighter alternative if you already have the infra. |
| **Debounce / merge** | Optional: merge bursts into a single `text` (explicit product rule). |

Without serialization, two simultaneous messages from the same user produce **two runs** and possible **races** on session-scoped shared memory.

---

## 6. Idempotency

- Key: **`externalMessageId`** (or stable hash of the event).
- Store “already processed” with TTL aligned to provider retry behavior.
- Avoid duplicating **`run`** when the webhook is redelivered.

---

## 7. Testing

- **Unit**: `ConversationGateway` with fake **`NormalizedInboundMessage`** and in-memory **`AgentRuntime`** / mock LLM.
- **Contract**: mock inbound/outbound adapters; no network required.
- **Integration**: one E2E adapter against a provider sandbox, outside the gateway unit test.

---

## 8. What this layer does not do

- It does not replace **`ContextBuilder`** or the engine protocol.
- It does not define a **single session-wide** LLM history: it remains **one `history` per `Run`**; see [`../core/11-context-builder.md`](../core/11-context-builder.md).
- It does not implement **multi-tenant auth** — that stays the host’s job ([`../core/08-scope-and-security.md`](../core/08-scope-and-security.md)).

---

## 9. Related documents

- [`13-canales-mensajeria-integracion.md`](./13-canales-mensajeria-integracion.md) — motivation and engine boundaries.
- [`07-multi-agente-rest-sesiones.md`](./07-multi-agente-rest-sesiones.md) — REST and sessions.
- [`../core/19-cluster-deployment.md`](../core/19-cluster-deployment.md) — `RunStore` and workers in distributed deployment.

---

## 10. Document status

Design proposal for **implementation in the product/host**; not a closed specification of the `agent-runtime` repo. Adjust names and DTOs to match your codebase when you implement the module.
