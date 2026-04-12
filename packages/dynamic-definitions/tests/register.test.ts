import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Agent,
  AgentRuntime,
  clearAllRegistriesForTests,
  InMemoryMemoryAdapter,
  resolveToolRegistry,
  Session,
  ToolRunner,
} from "@opencoreagents/core";
import type { AgentDefinitionPersisted, ToolContext } from "@opencoreagents/core";
import { InMemoryDefinitionsBackend } from "../src/store.js";
import {
  bindDefinitions,
  hydrateAgentDefinitionsFromStore,
  InMemoryDynamicDefinitionsStore,
  syncProjectDefinitionsToRegistry,
  upsertAgentDynamic,
  upsertHttpToolDynamic,
  upsertSkillDynamic,
} from "../src/register.js";

const ctx = (): ToolContext => ({
  projectId: "p1",
  agentId: "a1",
  runId: "r1",
  sessionId: "s1",
  memoryAdapter: new InMemoryMemoryAdapter(),
  securityContext: {
    principalId: "x",
    kind: "internal",
    organizationId: "o1",
    projectId: "p1",
    roles: ["agent"],
    scopes: ["*"],
  },
});

describe("dynamic-definitions", () => {
  afterEach(() => {
    clearAllRegistriesForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("upsertHttpToolDynamic registers tool for ToolRunner", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => "",
        json: async () => ({ echo: 1 }),
      }),
    );

    const store = new InMemoryDynamicDefinitionsStore();
    await upsertHttpToolDynamic(store, "p1", {
      id: "remote_ping",
      projectId: "p1",
      description: "Ping",
      inputSchema: { type: "object", properties: {} },
      http: { method: "GET", url: "https://api.example.com/ping" },
    });

    const runner = new ToolRunner(resolveToolRegistry("p1"), new Set(["remote_ping"]));
    const out = await runner.execute("remote_ping", {}, ctx());
    expect(out).toEqual({ echo: 1 });
  });

  it("rejects projectId mismatch on http tool", async () => {
    const store = new InMemoryDynamicDefinitionsStore();
    await expect(
      upsertHttpToolDynamic(store, "p1", {
        id: "x",
        projectId: "other",
        http: { method: "GET", url: "https://a.com" },
      }),
    ).rejects.toThrow(/mismatch/);
  });

  it("rejects scope global on http tool (project isolation only via dynamic path)", async () => {
    const store = new InMemoryDynamicDefinitionsStore();
    await expect(
      upsertHttpToolDynamic(store, "p1", {
        id: "evil",
        projectId: "p1",
        scope: "global",
        http: { method: "GET", url: "https://a.com" },
      }),
    ).rejects.toThrow(/not allowed for dynamic definitions/);
  });

  it("rejects scope global on skill", async () => {
    const store = new InMemoryDynamicDefinitionsStore();
    await expect(
      upsertSkillDynamic(store, "p1", {
        id: "s1",
        projectId: "p1",
        scope: "global",
        tools: [],
      }),
    ).rejects.toThrow(/not allowed for dynamic definitions/);
  });

  it("rejects scope global on agent", async () => {
    const store = new InMemoryDynamicDefinitionsStore();
    const bad = {
      id: "a1",
      projectId: "p1",
      scope: "global" as const,
      systemPrompt: "x",
      tools: [] as string[],
      llm: { provider: "openai", model: "gpt-4o-mini" },
    } as AgentDefinitionPersisted & { scope: "global" };
    await expect(upsertAgentDynamic(store, "p1", bad)).rejects.toThrow(
      /not allowed for dynamic definitions/,
    );
  });

  it("hydrateAgentDefinitionsFromStore throws if agent references a skill missing from store", async () => {
    const store = new InMemoryDynamicDefinitionsStore();
    await store.methods.saveAgent("p1", {
      id: "agent-x",
      projectId: "p1",
      systemPrompt: "x",
      skills: ["missing-skill"],
      tools: [],
      llm: { provider: "openai", model: "gpt-4o-mini" },
    });

    await expect(hydrateAgentDefinitionsFromStore(store, "p1", "agent-x")).rejects.toThrow(
      /skill not found in store/,
    );
  });

  it("hydrateAgentDefinitionsFromStore registers only closure for that agent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => "",
        json: async () => ({ ok: true }),
      }),
    );

    const store = new InMemoryDynamicDefinitionsStore();
    await store.methods.saveHttpTool("p1", {
      id: "http_only",
      projectId: "p1",
      http: { method: "GET", url: "https://api.example.com/x" },
    });
    await store.methods.saveHttpTool("p1", {
      id: "http_used",
      projectId: "p1",
      http: { method: "GET", url: "https://api.example.com/y" },
    });
    await store.methods.saveSkill("p1", {
      id: "sk1",
      projectId: "p1",
      tools: ["http_used"],
      description: "uses http",
    });
    await store.methods.saveAgent("p1", {
      id: "agent-a",
      projectId: "p1",
      systemPrompt: "Test.",
      skills: ["sk1"],
      tools: [],
      llm: { provider: "openai", model: "gpt-4o-mini" },
    });
    await store.methods.saveAgent("p1", {
      id: "agent-b",
      projectId: "p1",
      systemPrompt: "Other.",
      tools: [],
      llm: { provider: "openai", model: "gpt-4o-mini" },
    });

    await hydrateAgentDefinitionsFromStore(store, "p1", "agent-a");

    const reg = resolveToolRegistry("p1");
    expect(reg.has("http_used")).toBe(true);
    expect(reg.has("http_only")).toBe(false);

    const { getAgentDefinition } = await import("@opencoreagents/core");
    expect(getAgentDefinition("p1", "agent-a")?.id).toBe("agent-a");
    expect(getAgentDefinition("p1", "agent-b")).toBeUndefined();
  });

  it("syncProjectDefinitionsToRegistry applies skills and agents", async () => {
    const store = new InMemoryDynamicDefinitionsStore();
    await store.methods.saveSkill("p1", {
      id: "s_empty",
      projectId: "p1",
      tools: [],
      description: "noop skill",
    });
    await store.methods.saveAgent("p1", {
      id: "dyn-agent",
      projectId: "p1",
      systemPrompt: "You are a test agent.",
      skills: ["s_empty"],
      tools: [],
      llm: { provider: "openai", model: "gpt-4o-mini" },
    });

    await syncProjectDefinitionsToRegistry(store, "p1");

    const { getAgentDefinition } = await import("@opencoreagents/core");
    expect(getAgentDefinition("p1", "dyn-agent")?.id).toBe("dyn-agent");
  });

  it("upsertAgentDynamic allows load and run with mock LLM", async () => {
    const store = new InMemoryDynamicDefinitionsStore();

    let step = 0;
    const runtime = new AgentRuntime({
      llmAdapter: {
        async generate() {
          const content =
            step++ === 0
              ? JSON.stringify({ type: "thought", content: "t" })
              : JSON.stringify({ type: "result", content: "done" });
          return { content };
        },
      },
      memoryAdapter: new InMemoryMemoryAdapter(),
      maxIterations: 5,
    });

    await upsertAgentDynamic(store, "p1", {
      id: "live-agent",
      projectId: "p1",
      systemPrompt: "Test.",
      tools: [],
      llm: { provider: "openai", model: "gpt-4o-mini" },
    });

    const agent = await Agent.load("live-agent", runtime, {
      session: new Session({ id: "s1", projectId: "p1" }),
    });
    const run = await agent.run("hi");
    expect(run.status).toBe("completed");
  });

  it("bindDefinitions requires projectId on define payloads", async () => {
    const def = bindDefinitions(new InMemoryDefinitionsBackend());
    await expect(
      def.Agent.define({
        id: "x",
        systemPrompt: "x",
        tools: [],
        llm: { provider: "openai", model: "gpt-4o-mini" },
      } as AgentDefinitionPersisted),
    ).rejects.toThrow(/projectId/);
  });

  it("store.Agent.prepare restores registry from store after clear", async () => {
    const store = new InMemoryDynamicDefinitionsStore();
    await store.Skill.define({
      id: "sb",
      projectId: "p1",
      description: "d",
      tools: [],
    });
    await store.Agent.define({
      id: "ab",
      projectId: "p1",
      systemPrompt: "x",
      skills: ["sb"],
      tools: [],
      llm: { provider: "openai", model: "gpt-4o-mini" },
    });
    clearAllRegistriesForTests();
    await store.Agent.prepare({ projectId: "p1", agentId: "ab" });
    const { getAgentDefinition } = await import("@opencoreagents/core");
    expect(getAgentDefinition("p1", "ab")?.id).toBe("ab");
  });
});
