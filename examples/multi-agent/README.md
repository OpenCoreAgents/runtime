# Multi-agent example (`InProcessMessageBus` + `send_message`)

Two small demos in one script:

1. **Fire-and-forget** — one agent emits a **`send_message`** **`event`**; another agent id is only an **inbox** you **`waitFor`** in application code.
2. **Request–reply** — agent A sends a **`request`** with a **`correlationId`**; a background handler simulates agent B and **`bus.send`**s a **`reply`**; the main script **`waitFor`**s the reply on A’s inbox.

Uses a **deterministic mock LLM** (no `OPENAI_API_KEY`). **`InProcessMessageBus`** is **single-process only** — for Redis-backed delivery across workers, see [`docs/core/09-communication-multiagent.md`](../../docs/core/09-communication-multiagent.md) and [`docs/core/19-cluster-deployment.md`](../../docs/core/19-cluster-deployment.md).

Full runnable code: [`src/main.ts`](./src/main.ts) (two demos), scripted steps: [`src/scriptedLlmQueues.ts`](./src/scriptedLlmQueues.ts).

## Example: using the same pattern

**1. Wire the bus** — without `messageBus` on `AgentRuntime`, the `send_message` tool throws.

```typescript
import {
  Agent,
  AgentRuntime,
  Session,
  InMemoryMemoryAdapter,
  InProcessMessageBus,
} from "@agent-runtime/core";

const bus = new InProcessMessageBus();
const session = new Session({ id: "s1", projectId: "my-project" });

const runtime = new AgentRuntime({
  llmAdapter: myLlmAdapter, // e.g. OpenAILLMAdapter or a mock QueueLLM
  memoryAdapter: new InMemoryMemoryAdapter(),
  messageBus: bus,
});
```

**2. Define an agent that may call `send_message`** — tool id must be in `tools`.

```typescript
await Agent.define({
  id: "agent-a",
  projectId: "my-project",
  systemPrompt: "Use send_message to notify other agents when appropriate.",
  tools: ["send_message"],
  llm: { provider: "openai", model: "gpt-4o-mini" },
});
```

**3. Fire-and-forget** — subscribe to the **recipient’s** inbox, then run the sender (order matters so you don’t miss the message).

```typescript
const inbox = bus.waitFor("agent-b", { fromAgentId: "agent-a" });
const agentA = await Agent.load("agent-a", runtime, { session });
await agentA.run("Notify agent-b.");
const msg = await inbox; // AgentMessage: type, payload, correlationId?, …
```

**4. Request–reply** — register **`waitFor`** on the **caller’s** id for a **`reply`** from the peer **before** the reply is sent. The callee can be another `Agent.load` + `run`, or plain `bus.waitFor` + `bus.send` like [`src/main.ts`](./src/main.ts) demo 2.

```typescript
const correlationId = crypto.randomUUID();

const replyPromise = bus.waitFor("agent-a", {
  fromAgentId: "agent-b",
  correlationId,
});

// Elsewhere (another task): after agent-a’s request lands on agent-b’s inbox,
// await bus.send({ fromAgentId: "agent-b", toAgentId: "agent-a", projectId, sessionId: session.id, type: "reply", correlationId, payload: { ok: true }, meta: { ts: new Date().toISOString() } });

const reply = await replyPromise;
```

## Prerequisite

```bash
# from repository root
pnpm turbo run build --filter=@agent-runtime/core
```

## Run

```bash
pnpm install
pnpm --filter @agent-runtime/example-multi-agent start
```

Or from this directory:

```bash
pnpm start
```

## Next steps

- Enforce allowed targets with **`AgentRuntime({ sendMessageTargetPolicy: … })`** — see [`docs/core/08-scope-and-security.md`](../../docs/core/08-scope-and-security.md).
- Replace the mock LLM with **`OpenAILLMAdapter`** and give agents real **`systemPrompt`** instructions to use **`send_message`** when appropriate.
