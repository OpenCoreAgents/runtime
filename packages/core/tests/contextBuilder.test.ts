import { describe, expect, it, beforeEach } from "vitest";
import type { Run } from "../src/protocol/types.js";
import type { AgentDefinition } from "../src/define/types.js";
import type { SecurityContext } from "../src/security/types.js";
import { ContextBuilder } from "../src/context/ContextBuilder.js";
import { Session } from "../src/define/Session.js";
import {
  InMemoryMemoryAdapter,
  Tool,
  clearAllRegistriesForTests,
  resolveToolRegistry,
} from "../src/index.js";
import type { ToolVisibilityPolicyInput } from "../src/types.js";

const stubAgent: AgentDefinition = {
  id: "a",
  projectId: "p",
  systemPrompt: "You are helpful.",
  tools: [],
  llm: { provider: "openai", model: "gpt-4o-mini" },
};

const stubSecurity: SecurityContext = {
  principalId: "internal",
  kind: "internal",
  organizationId: "p",
  projectId: "p",
  roles: ["agent"],
  scopes: ["*"],
};

describe("ContextBuilder", () => {
  beforeEach(() => {
    clearAllRegistriesForTests();
  });

  it("splices continueInputs after each result (chronological user turns)", async () => {
    const run: Run = {
      runId: "r1",
      agentId: "a",
      sessionId: "s",
      status: "running",
      history: [
        {
          type: "result",
          content: "Answer about A",
          meta: { ts: "1", source: "llm" },
        },
        {
          type: "thought",
          content: "think B",
          meta: { ts: "2", source: "llm" },
        },
        {
          type: "result",
          content: "Answer about B",
          meta: { ts: "3", source: "llm" },
        },
      ],
      state: {
        iteration: 0,
        pending: null,
        userInput: "first question",
        continueInputs: ["second question", "third question"], // two `result` rows → two splices
      },
    };

    const cb = new ContextBuilder();
    const built = await cb.build({
      agent: stubAgent,
      run,
      session: new Session({ id: "s", projectId: "p" }),
      memoryAdapter: new InMemoryMemoryAdapter(),
      securityContext: stubSecurity,
      toolRegistry: new Map(),
    });

    const roles = built.messages.map((m) => m.role);
    expect(roles[0]).toBe("system");
    expect(roles[1]).toBe("user");
    expect(built.messages[1]!.content).toBe("first question");
    expect(roles[2]).toBe("assistant");
    expect(built.messages[2]!.content).toContain("Answer about A");
    expect(roles[3]).toBe("user");
    expect(built.messages[3]!.content).toBe("second question");
    expect(roles[4]).toBe("assistant");
    expect(built.messages[4]!.content).toContain("think B");
    expect(roles[5]).toBe("assistant");
    expect(built.messages[5]!.content).toContain("Answer about B");
    expect(roles[6]).toBe("user");
    expect(built.messages[6]!.content).toBe("third question");
  });

  it("splices resumeInputs after each wait", async () => {
    const run: Run = {
      runId: "r2",
      agentId: "a",
      status: "running",
      history: [
        {
          type: "wait",
          content: { reason: "need", details: {} },
          meta: { ts: "1", source: "llm" },
        },
        {
          type: "result",
          content: "after resume",
          meta: { ts: "2", source: "llm" },
        },
      ],
      state: {
        iteration: 0,
        pending: null,
        userInput: "start",
        resumeInputs: ["user resume text"],
      },
    };

    const cb = new ContextBuilder();
    const built = await cb.build({
      agent: stubAgent,
      run,
      session: new Session({ id: "s", projectId: "p" }),
      memoryAdapter: new InMemoryMemoryAdapter(),
      securityContext: stubSecurity,
      toolRegistry: new Map(),
    });

    const users = built.messages.filter((m) => m.role === "user").map((m) => m.content as string);
    expect(users[0]).toBe("start");
    expect(users[1]).toBe("user resume text");
    expect(users).toHaveLength(2);
  });

  it("applies visibility policy after the effective allowlist and caps candidates", async () => {
    const execute = async () => ({ ok: true });
    await Tool.define({
      id: "vis_a",
      scope: "global",
      description: "A",
      inputSchema: { type: "object", properties: {} },
      execute,
    });
    await Tool.define({
      id: "vis_b",
      scope: "global",
      description: "B",
      inputSchema: { type: "object", properties: {} },
      execute,
    });
    await Tool.define({
      id: "vis_c",
      scope: "global",
      description: "C (outside effective allowlist)",
      inputSchema: { type: "object", properties: {} },
      execute,
    });

    const run: Run = {
      runId: "r-vis",
      agentId: "a",
      sessionId: "s",
      status: "running",
      history: [],
      state: { iteration: 0, pending: null, userInput: "hi" },
    };
    const seenPolicyInputs: ToolVisibilityPolicyInput[] = [];
    const cb = new ContextBuilder();
    const built = await cb.build({
      agent: { ...stubAgent, id: "a-vis", tools: ["vis_a", "vis_b", "vis_c"] },
      run,
      session: new Session({ id: "s-vis", projectId: "p" }),
      memoryAdapter: new InMemoryMemoryAdapter(),
      securityContext: stubSecurity,
      toolRegistry: resolveToolRegistry("p"),
      // Only vis_a / vis_b survive the effective allowlist; vis_c is never consulted.
      effectiveToolAllowlist: new Set(["vis_a", "vis_b"]),
      visibilityPolicy: async (input) => {
        seenPolicyInputs.push(input);
        return { visible: input.tool.name !== "vis_b" };
      },
      hostContext: { requestId: "req-1" },
    });

    const names = (built.tools ?? []).map((t) => t.name);
    expect(names).toEqual(["vis_a"]);

    // The policy only saw allowlist candidates, with the full compatible input shape.
    const visitedNames = seenPolicyInputs.map((i) => i.tool.name).sort();
    expect(visitedNames).toEqual(["vis_a", "vis_b"]);
    const first = seenPolicyInputs[0]!;
    expect(first.agent.id).toBe("a-vis");
    expect(first.session.id).toBe("s-vis");
    expect(first.run.runId).toBe("r-vis");
    expect(first.securityContext.principalId).toBe("internal");
    expect(first.hostContext).toEqual({ requestId: "req-1" });
  });

  it("falls back to agent tools when effectiveToolAllowlist is omitted (backward compatible)", async () => {
    await Tool.define({
      id: "vis_legacy",
      scope: "global",
      description: "Legacy",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    });

    const run: Run = {
      runId: "r-legacy",
      agentId: "a",
      sessionId: "s",
      status: "running",
      history: [],
      state: { iteration: 0, pending: null, userInput: "hi" },
    };
    const cb = new ContextBuilder();
    const built = await cb.build({
      agent: { ...stubAgent, tools: ["vis_legacy"] },
      run,
      session: new Session({ id: "s", projectId: "p" }),
      memoryAdapter: new InMemoryMemoryAdapter(),
      securityContext: stubSecurity,
      toolRegistry: resolveToolRegistry("p"),
    });

    const names = (built.tools ?? []).map((t) => t.name);
    expect(names).toEqual(["vis_legacy"]);
  });
});
