import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Redis from "ioredis-mock";
import { hydrateAgentDefinitionsFromStore } from "@opencoreagents/dynamic-definitions";
import {
  clearAllRegistriesForTests,
  getAgentDefinition,
  InMemoryMemoryAdapter,
  resolveToolRegistry,
  ToolRunner,
} from "@opencoreagents/core";
import { RedisDynamicDefinitionsStore } from "../src/RedisDynamicDefinitionsStore.js";

describe("RedisDynamicDefinitionsStore", () => {
  let redis: Redis;

  beforeEach(() => {
    redis = new Redis();
    clearAllRegistriesForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("persists and lists definitions; per-job hydrate loads one agent into registry", async () => {
    const store = new RedisDynamicDefinitionsStore(redis, { keyPrefix: "def" });

    await store.methods.saveSkill("acme", {
      id: "summarize",
      projectId: "acme",
      tools: [],
      description: "Summarize text",
    });
    await store.methods.saveAgent("acme", {
      id: "agent-1",
      projectId: "acme",
      systemPrompt: "You summarize.",
      skills: ["summarize"],
      tools: [],
      llm: { provider: "openai", model: "gpt-4o-mini" },
    });

    const snap = await store.methods.getSnapshot("acme");
    expect(snap.skills).toHaveLength(1);
    expect(snap.agents).toHaveLength(1);

    await hydrateAgentDefinitionsFromStore(store, "acme", "agent-1");

    expect(getAgentDefinition("acme", "agent-1")?.id).toBe("agent-1");
  });

  it("uses custom key prefix", async () => {
    const store = new RedisDynamicDefinitionsStore(redis, { keyPrefix: "mydef" });
    await store.methods.saveAgent("p1", {
      id: "a",
      projectId: "p1",
      systemPrompt: "x",
      tools: [],
      llm: { provider: "openai", model: "gpt-4o-mini" },
    });

    const keys = await redis.keys("mydef:p1:*");
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((k) => k.includes("agents"))).toBe(true);
  });

  it("hydrate registers HTTP tool from Redis when agent references it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => "",
        json: async () => ({ ok: true }),
      }),
    );

    const store = new RedisDynamicDefinitionsStore(redis, { keyPrefix: "def" });
    await store.methods.saveHttpTool("p1", {
      id: "remote_echo",
      projectId: "p1",
      description: "Echo",
      inputSchema: { type: "object", properties: {} },
      http: { method: "GET", url: "https://api.example.com/echo" },
    });
    await store.methods.saveAgent("p1", {
      id: "agent-http",
      projectId: "p1",
      systemPrompt: "Use tools.",
      tools: ["remote_echo"],
      skills: [],
      llm: { provider: "openai", model: "gpt-4o-mini" },
    });

    await hydrateAgentDefinitionsFromStore(store, "p1", "agent-http");

    const runner = new ToolRunner(resolveToolRegistry("p1"), new Set(["remote_echo"]));
    const out = await runner.execute("remote_echo", {}, {
      projectId: "p1",
      agentId: "agent-http",
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
    expect(out).toEqual({ ok: true });
  });
});
