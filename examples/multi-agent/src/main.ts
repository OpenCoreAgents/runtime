/**
 * Multi-agent demo: InProcessMessageBus + send_message (event + request/reply).
 * Mock LLM only — no API keys. See ../README.md.
 */
import type { LLMAdapter, LLMRequest, LLMResponse } from "@agent-runtime/core";
import {
  Agent,
  AgentRuntime,
  Session,
  InMemoryMemoryAdapter,
  InProcessMessageBus,
} from "@agent-runtime/core";
import {
  DEMO_EVENT_LLM_STEPS,
  demoRequestReplyLlmSteps,
} from "./scriptedLlmQueues.js";

const PROJECT = "example-multi-agent";

/** Returns queued JSON steps; falls back to a terminal result. */
class QueueLLM implements LLMAdapter {
  constructor(private readonly queue: string[]) {}
  private i = 0;
  async generate(_req: LLMRequest): Promise<LLMResponse> {
    const content =
      this.queue[this.i++] ??
      JSON.stringify({ type: "result", content: "Done (mock LLM queue empty)." });
    return { content };
  }
}

async function demoEvent(): Promise<void> {
  console.log("\n--- Demo 1: event (fire-and-forget) ---\n");

  const bus = new InProcessMessageBus();
  const session = new Session({ id: "session-event", projectId: PROJECT });
  // Mock LLM: pops scripted Step JSON from ./scriptedLlmQueues (spread = mutable copy; export is readonly).
  const llm = new QueueLLM([...DEMO_EVENT_LLM_STEPS]);

  const runtime = new AgentRuntime({
    llmAdapter: llm,
    memoryAdapter: new InMemoryMemoryAdapter(),
    messageBus: bus,
    maxIterations: 10,
  });

  await Agent.define({
    id: "notifier-agent",
    projectId: PROJECT,
    systemPrompt: "You coordinate handoffs to other agents.",
    tools: ["send_message"],
    llm: { provider: "openai", model: "gpt-4o-mini" },
  });

  const inbox = bus.waitFor("inventory-agent", { fromAgentId: "notifier-agent" });
  const agent = await Agent.load("notifier-agent", runtime, { session });
  const run = await agent.run("Ship the refund update to inventory.");

  const msg = await inbox;
  console.log("Run status:", run.status);
  console.log("Message on inventory-agent inbox:", {
    type: msg.type,
    from: msg.fromAgentId,
    payload: msg.payload,
  });
}

async function demoRequestReply(): Promise<void> {
  console.log("\n--- Demo 2: request + reply (correlationId) ---\n");

  const bus = new InProcessMessageBus();
  const session = new Session({ id: "session-req", projectId: PROJECT });
  const correlationId = `ticket-${Date.now()}`;

  // Same mock pattern; steps include this run’s correlationId (see ./scriptedLlmQueues).
  const llm = new QueueLLM(demoRequestReplyLlmSteps(correlationId));

  const runtime = new AgentRuntime({
    llmAdapter: llm,
    memoryAdapter: new InMemoryMemoryAdapter(),
    messageBus: bus,
    maxIterations: 10,
  });

  await Agent.define({
    id: "coordinator-agent",
    projectId: PROJECT,
    systemPrompt: "You escalate to specialists with a clear request.",
    tools: ["send_message"],
    llm: { provider: "openai", model: "gpt-4o-mini" },
  });

  // Coordinator must be listening for the reply before the specialist answers.
  const coordinatorInbox = bus.waitFor("coordinator-agent", {
    fromAgentId: "specialist-agent",
    correlationId,
  });

  // Simulates specialist-agent processing in the same process (no second Agent.load).
  const specialistSide = (async () => {
    const req = await bus.waitFor("specialist-agent", {
      fromAgentId: "coordinator-agent",
      correlationId,
    });
    console.log("[specialist-agent] received request:", req.payload);
    await bus.send({
      fromAgentId: "specialist-agent",
      toAgentId: "coordinator-agent",
      projectId: PROJECT,
      sessionId: session.id,
      type: "reply",
      correlationId,
      payload: {
        decision: "retry_payment_webhook",
        note: "Idempotent replay; escalate to human if second failure.",
      },
      meta: { ts: new Date().toISOString() },
    });
  })();

  const coordinator = await Agent.load("coordinator-agent", runtime, { session });
  const run = await coordinator.run("Escalate the checkout timeout.");

  const reply = await coordinatorInbox;
  await specialistSide;

  console.log("Run status:", run.status);
  console.log("Reply on coordinator-agent inbox:", reply.payload);
}

async function main(): Promise<void> {
  await demoEvent();
  await demoRequestReply();
  console.log("\nDone.\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
