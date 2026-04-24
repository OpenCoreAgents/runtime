# Bot Guide with Conversation Gateway

Status: stable  
Audience: users, contributors

This guide shows how to build bot-style integrations (Telegram, WhatsApp-like channels, chat widgets) with `@opencoreagents/conversation-gateway`.

## What Conversation Gateway does

`ConversationGateway` orchestrates:

1. inbound message normalization
2. session resolution
3. run vs resume selection
4. outbound reply dispatch

It is channel-agnostic: your transport adapter converts provider payloads into `NormalizedInboundMessage`.

## Recommended architecture

Use this flow in production:

1. Receive webhook request.
2. Verify signature/token.
3. Acknowledge fast (`200`).
4. Enqueue work.
5. Worker calls `gateway.handleInbound(...)`.

Do not run long agent work inside a slow webhook handler.

## Step 1: Normalize inbound payloads

Convert provider-specific messages to `NormalizedInboundMessage`:

```typescript
import type { NormalizedInboundMessage } from "@opencoreagents/conversation-gateway";

function toNormalized(payload: { chatId: string; text: string; messageId: string }): NormalizedInboundMessage {
  return {
    conversationKey: `chat:${payload.chatId}`,
    text: payload.text,
    externalMessageId: payload.messageId,
    receivedAt: new Date().toISOString(),
    metadata: { channel: "custom-bot" },
  };
}
```

Use a stable `conversationKey` per chat/thread.

## Step 2: Prepare runtime and agent

```typescript
import { Agent, AgentRuntime, InMemoryMemoryAdapter, InMemoryRunStore } from "@opencoreagents/core";

const PROJECT_ID = "bot-prod";
const AGENT_ID = "support_bot";

const runStore = new InMemoryRunStore();
const runtime = new AgentRuntime({
  llmAdapter,
  memoryAdapter: new InMemoryMemoryAdapter(),
  runStore,
});

await Agent.define({
  id: AGENT_ID,
  projectId: PROJECT_ID,
  systemPrompt: "You are a concise support bot.",
  tools: [],
  llm: { provider: "openai", model: "gpt-4o-mini" },
});
```

For production, replace in-memory adapters with Redis-backed ones.

## Step 3: Configure ConversationGateway

```typescript
import {
  ConversationGateway,
  findWaitingRunIdFromRunStore,
  type OutboundDispatcher,
} from "@opencoreagents/conversation-gateway";

const seen = new Set<string>();

const outbound: OutboundDispatcher = {
  async sendReply(conversationKey, text, opts) {
    await channelClient.sendMessage({
      conversationKey,
      text,
      runId: opts?.runId,
    });
  },
};

const gateway = new ConversationGateway({
  runtime,
  agentId: AGENT_ID,
  resolveSession: (conversationKey) => ({
    sessionId: `sess-${conversationKey}`,
    projectId: PROJECT_ID,
  }),
  findWaitingRunId: (projectId, sessionId, agentId, tenantId) =>
    findWaitingRunIdFromRunStore(runStore, projectId, sessionId, agentId, tenantId),
  outbound,
  idempotency: {
    seen: (id) => seen.has(id),
    markProcessed: (id) => void seen.add(id),
  },
  limits: { maxTextLength: 4096 },
  hooks: {
    onDiscard: (reason, msg) => console.warn("discarded", reason, msg.externalMessageId),
    onError: (error, msg) => console.error("gateway_error", msg.externalMessageId, error),
  },
});
```

## Step 4: Handle inbound messages in workers

```typescript
async function processInbound(payload: BotPayload): Promise<void> {
  const msg = toNormalized(payload);
  await gateway.handleInbound(msg);
}
```

`ConversationGateway` will:

- call `findWaitingRunId(...)`
- `resume` if a waiting run exists
- otherwise call `run`
- extract reply text and call `outbound.sendReply(...)`

## Wait/resume behavior

If a prior run is `waiting`, the next user message resumes that run automatically through `findWaitingRunId`.

This gives a natural conversational loop for human-in-the-loop bot flows.

## Production checklist

- Signature verification before enqueueing.
- Distributed idempotency store (Redis/DB), not an in-memory `Set`.
- Per-conversation serialization (`conversationKey` FIFO/lock) to avoid overlapping runs.
- Retry and backoff in queue workers.
- Outbound safeguards when run status is `waiting` and no user-visible reply should be sent.
- Metrics: inbound count, discard reasons, gateway errors, run latency, queue lag.

## Runnable reference

- [Telegram mocked example](../../examples/telegram-example-mocked/README.md)
- [Conversation Gateway package](../../packages/conversation-gateway/README.md)
