import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMAdapter, LLMResponse } from "../src/adapters/llm/LLMAdapter.js";
import type { ExecutionPolicy, PublicRunEvent } from "../src/index.js";
import {
  Agent,
  AgentRuntime,
  InMemoryMemoryAdapter,
  InMemoryRunStore,
  Session,
  Tool,
  approvePendingAction,
  buildEngineDeps,
  clearAllRegistriesForTests,
  createRun,
  executeRun,
  getAgentDefinition,
  PUBLIC_RUN_EVENT_SCHEMA_VERSION,
} from "../src/index.js";
import { RunCancelledError } from "../src/errors/index.js";

class QueueLLM implements LLMAdapter {
  private i = 0;
  constructor(private readonly queue: string[]) {}
  async generate(): Promise<LLMResponse> {
    const content =
      this.queue[this.i++] ??
      JSON.stringify({ type: "result", content: "fallback" });
    return { content };
  }
}

function collector() {
  const events: PublicRunEvent[] = [];
  return { events, sink: (e: PublicRunEvent) => events.push(e) };
}

beforeEach(() => {
  clearAllRegistriesForTests();
});

describe("public run events", () => {
  it("normal run: stable order, versioned envelope, JSON-serializable", async () => {
    await Tool.define({
      id: "pe_tool",
      scope: "global",
      description: "t",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    });
    const llm = new QueueLLM([
      JSON.stringify({ type: "action", tool: "pe_tool", input: {} }),
      JSON.stringify({ type: "result", content: "done" }),
    ]);
    const { events, sink } = collector();
    const rt = new AgentRuntime({
      llmAdapter: llm,
      memoryAdapter: new InMemoryMemoryAdapter(),
      maxIterations: 10,
      eventSinks: [sink],
    });
    await Agent.define({
      id: "a_pe",
      projectId: "p1",
      systemPrompt: "T.",
      tools: ["pe_tool"],
      llm: { provider: "openai", model: "gpt-4o" },
    });
    const session = new Session({ id: "s_pe", projectId: "p1" });
    const agent = await Agent.load("a_pe", rt, { session });
    const run = await agent.run("go");

    expect(run.status).toBe("completed");
    expect(events.map((e) => e.type)).toEqual([
      "run_started",
      "tool_proposed",
      "tool_started",
      "tool_completed",
      "run_completed",
    ]);
    for (const e of events) {
      expect(e.schemaVersion).toBe(PUBLIC_RUN_EVENT_SCHEMA_VERSION);
      expect(e.runId).toBe(run.runId);
      expect(e.agentId).toBe("a_pe");
      expect(e.projectId).toBe("p1");
      expect(e.eventId).toBeTruthy();
      expect(e.ts).toBeTruthy();
    }
    const round = JSON.parse(JSON.stringify(events)) as PublicRunEvent[];
    expect(round).toEqual(events);
  });

  it("policy deny: proposed -> denied, never started", async () => {
    await Tool.define({
      id: "pe_denied",
      scope: "global",
      description: "t",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    });
    const policy: ExecutionPolicy = async (input) =>
      input.tool.name === "pe_denied"
        ? { decision: "deny", reason: "nope" }
        : { decision: "allow" };
    const llm = new QueueLLM([
      JSON.stringify({ type: "action", tool: "pe_denied", input: {} }),
      JSON.stringify({ type: "result", content: "done" }),
    ]);
    const { events, sink } = collector();
    const rt = new AgentRuntime({
      llmAdapter: llm,
      memoryAdapter: new InMemoryMemoryAdapter(),
      maxIterations: 10,
      eventSinks: [sink],
      executionPolicy: policy,
    });
    await Agent.define({
      id: "a_pe_deny",
      projectId: "p1",
      systemPrompt: "T.",
      tools: ["pe_denied"],
      llm: { provider: "openai", model: "gpt-4o" },
    });
    const session = new Session({ id: "s1", projectId: "p1" });
    const agent = await Agent.load("a_pe_deny", rt, { session });
    await agent.run("go");

    expect(events.map((e) => e.type)).toEqual([
      "run_started",
      "tool_proposed",
      "tool_denied",
      "run_completed",
    ]);
    const denied = events.find((e) => e.type === "tool_denied");
    expect(denied && "code" in denied && denied.code).toBe(
      "EXECUTION_POLICY_DENIED",
    );
  });

  it("approval lifecycle: waiting -> approved -> executed -> completed", async () => {
    let proposals = 0;
    const policy: ExecutionPolicy = async (input) => {
      if (input.tool.name !== "pe_appr") return { decision: "allow" };
      proposals++;
      return proposals === 1
        ? { decision: "wait", reason: "needs_approval", ttlMs: 60_000 }
        : { decision: "allow" };
    };
    await Tool.define({
      id: "pe_appr",
      scope: "global",
      description: "t",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    });
    const llm = new QueueLLM([
      JSON.stringify({ type: "action", tool: "pe_appr", input: {} }),
      JSON.stringify({ type: "result", content: "after approval" }),
    ]);
    const store = new InMemoryRunStore();
    const { events, sink } = collector();
    const rt = new AgentRuntime({
      llmAdapter: llm,
      memoryAdapter: new InMemoryMemoryAdapter(),
      maxIterations: 10,
      eventSinks: [sink],
      runStore: store,
      executionPolicy: policy,
    });
    await Agent.define({
      id: "a_pe_appr",
      projectId: "p1",
      systemPrompt: "T.",
      tools: ["pe_appr"],
      llm: { provider: "openai", model: "gpt-4o" },
    });
    const session = new Session({ id: "s_pe_appr", projectId: "p1" });
    const agent = await Agent.load("a_pe_appr", rt, { session });
    const run = await agent.run("go");

    expect(run.status).toBe("waiting");
    expect(events.map((e) => e.type)).toEqual([
      "run_started",
      "tool_proposed",
      "tool_awaiting_approval",
      "run_waiting",
    ]);
    const awaiting = events.find((e) => e.type === "tool_awaiting_approval");
    expect(awaiting && "actionId" in awaiting).toBe(true);
    const rw = events.find((e) => e.type === "run_waiting");
    expect(rw && "pendingKind" in rw && rw.pendingKind).toBe("tool_approval");

    events.length = 0;
    const pending = run.state.pending as { kind: string; actionId: string };
    expect(pending.kind).toBe("tool_approval");
    const res = await approvePendingAction(rt, {
      runId: run.runId,
      actionId: pending.actionId,
      session,
    });
    expect(res.executed).toBe(true);
    expect(res.run.status).toBe("completed");
    // Approval-path execution emits its own tool events; the continued engine
    // loop then re-enters (no resumeMessages) emitting run_started/completed.
    expect(events.map((e) => e.type)).toEqual([
      "tool_started",
      "tool_completed",
      "run_resumed",
      "run_started",
      "run_completed",
    ]);
  });

  it("cancelled runs emit run_cancelled, not run_failed", async () => {
    await Tool.define({
      id: "pe_cxl",
      scope: "global",
      description: "t",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    });
    const llm = new QueueLLM([
      JSON.stringify({ type: "action", tool: "pe_cxl", input: {} }),
    ]);
    const { events, sink } = collector();
    const rt = new AgentRuntime({
      llmAdapter: llm,
      memoryAdapter: new InMemoryMemoryAdapter(),
      maxIterations: 10,
      eventSinks: [sink],
    });
    await Agent.define({
      id: "a_pe_cxl",
      projectId: "p1",
      systemPrompt: "T.",
      tools: ["pe_cxl"],
      llm: { provider: "openai", model: "gpt-4o" },
    });
    const agentDef = getAgentDefinition("p1", "a_pe_cxl")!;
    const session = new Session({ id: "s_pe_cxl", projectId: "p1" });
    const ctl = new AbortController();
    ctl.abort();
    const base = buildEngineDeps(agentDef, session, rt, { signal: ctl.signal });
    const run = createRun("a_pe_cxl", session.id, "go", "p1");

    await expect(
      executeRun(run, { ...base, startedAtMs: Date.now() }),
    ).rejects.toBeInstanceOf(RunCancelledError);

    expect(events.map((e) => e.type)).toEqual([
      "run_started",
      "run_cancelled",
    ]);
    expect(events.some((e) => e.type === "run_failed")).toBe(false);
  });

  it("redactor transforms events before delivery", async () => {
    await Tool.define({
      id: "pe_red",
      scope: "global",
      description: "t",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    });
    const llm = new QueueLLM([
      JSON.stringify({ type: "action", tool: "pe_red", input: {} }),
      JSON.stringify({ type: "result", content: "done" }),
    ]);
    const { events, sink } = collector();
    const redactor = (input: { value: unknown }) => {
      if (!input.value || typeof input.value !== "object") return input.value;
      const copy = { ...(input.value as Record<string, unknown>) };
      delete copy.projectId;
      return copy;
    };
    const rt = new AgentRuntime({
      llmAdapter: llm,
      memoryAdapter: new InMemoryMemoryAdapter(),
      maxIterations: 10,
      eventSinks: [sink],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redactor: redactor as any,
    });
    await Agent.define({
      id: "a_pe_red",
      projectId: "p1",
      systemPrompt: "T.",
      tools: ["pe_red"],
      llm: { provider: "openai", model: "gpt-4o" },
    });
    const session = new Session({ id: "s_pe_red", projectId: "p1" });
    const agent = await Agent.load("a_pe_red", rt, { session });
    await agent.run("go");

    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect("projectId" in e).toBe(false);
      expect(e.runId).toBeTruthy();
    }
  });

  it("sink failure is swallowed by default and opt-in propagates", async () => {
    const mk = (failOnEventSinkError?: boolean) => {
      const good = collector();
      const boom = () => {
        throw new Error("sink down");
      };
      void failOnEventSinkError;
      return { good, boom };
    };

    await Tool.define({
      id: "pe_sink",
      scope: "global",
      description: "t",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    });

    // Default: throwing sink ignored, healthy sink still receives.
    {
      const llm = new QueueLLM([
        JSON.stringify({ type: "action", tool: "pe_sink", input: {} }),
        JSON.stringify({ type: "result", content: "done" }),
      ]);
      const { good, boom } = mk();
      const rt = new AgentRuntime({
        llmAdapter: llm,
        memoryAdapter: new InMemoryMemoryAdapter(),
        maxIterations: 10,
        eventSinks: [boom, good.sink],
      });
      await Agent.define({
        id: "a_pe_sink",
        projectId: "p1",
        systemPrompt: "T.",
        tools: ["pe_sink"],
        llm: { provider: "openai", model: "gpt-4o" },
      });
      const session = new Session({ id: "s1", projectId: "p1" });
      const agent = await Agent.load("a_pe_sink", rt, { session });
      const run = await agent.run("go");
      expect(run.status).toBe("completed");
      expect(good.events.length).toBeGreaterThan(0);
    }

    // Opt-in: sink error propagates and fails the run.
    {
      clearAllRegistriesForTests();
      await Tool.define({
        id: "pe_sink",
        scope: "global",
        description: "t",
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({ ok: true }),
      });
      const llm = new QueueLLM([
        JSON.stringify({ type: "result", content: "never reached" }),
      ]);
      const rt = new AgentRuntime({
        llmAdapter: llm,
        memoryAdapter: new InMemoryMemoryAdapter(),
        maxIterations: 10,
        eventSinks: [() => {
          throw new Error("sink down");
        }],
        failOnEventSinkError: true,
      });
      await Agent.define({
        id: "a_pe_sink2",
        projectId: "p1",
        systemPrompt: "T.",
        tools: ["pe_sink"],
        llm: { provider: "openai", model: "gpt-4o" },
      });
      const session = new Session({ id: "s2", projectId: "p1" });
      const agent = await Agent.load("a_pe_sink2", rt, { session });
      await expect(agent.run("go")).rejects.toThrow("sink down");
    }
  });
});