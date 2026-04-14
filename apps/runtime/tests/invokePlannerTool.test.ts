import type { DynamicDefinitionsStore } from "@opencoreagents/dynamic-definitions";
import {
  InMemoryMemoryAdapter,
  ToolRunner,
  clearAllRegistriesForTests,
  resolveToolRegistry,
  type ToolContext,
} from "@opencoreagents/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultStackConfig } from "../src/config/defaults.js";
import {
  RUNTIME_INVOKE_PLANNER_TOOL_ID,
  registerRuntimeInvokePlannerTool,
} from "../src/runtime/invokePlannerTool.js";
import type { ResolvedRuntimeStackConfig } from "../src/config/types.js";

function toolCtx(over: Partial<ToolContext> & Pick<ToolContext, "agentId">): ToolContext {
  return {
    projectId: "proj-a",
    runId: "run-chat-1",
    sessionId: "sess-chat-1",
    memoryAdapter: new InMemoryMemoryAdapter(),
    securityContext: {
      principalId: "internal",
      kind: "internal",
      organizationId: "proj-a",
      projectId: "proj-a",
      roles: ["agent"],
      scopes: ["*"],
    },
    ...over,
  };
}

function mockStoreWithAgents(ids: string[]): DynamicDefinitionsStore {
  return {
    methods: {
      listAgents: vi.fn().mockImplementation(async (projectId: string) =>
        ids.map((id) => ({ id, projectId })),
      ),
    },
  } as unknown as DynamicDefinitionsStore;
}

describe("registerRuntimeInvokePlannerTool (mocked enqueue + store)", () => {
  let config: ResolvedRuntimeStackConfig;
  let enqueueRun: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    clearAllRegistriesForTests();
    config = {
      ...defaultStackConfig,
      planner: {
        ...defaultStackConfig.planner,
        defaultAgent: { ...defaultStackConfig.planner.defaultAgent, id: "planner" },
      },
    };
    enqueueRun = vi.fn().mockResolvedValue({ id: "job-mock-1" });
  });

  async function setupRegister(store: DynamicDefinitionsStore) {
    await registerRuntimeInvokePlannerTool({
      definitionsStore: store,
      config,
      enqueueRun,
      defaultPlannerAgentId: "planner",
    });
    return new ToolRunner(resolveToolRegistry("proj-a"), new Set([RUNTIME_INVOKE_PLANNER_TOOL_ID]));
  }

  it("enqueues planner run with goal, sessionContext from caller, and planner-invoke session", async () => {
    const store = mockStoreWithAgents(["planner"]);
    const runner = await setupRegister(store);

    const out = (await runner.execute(
      RUNTIME_INVOKE_PLANNER_TOOL_ID,
      { goal: "Do the thing" },
      toolCtx({ agentId: "chat" }),
    )) as Record<string, unknown>;

    expect(out.status).toBe("queued");
    expect(out.jobId).toBe("job-mock-1");
    expect(out.plannerAgentId).toBe("planner");
    expect(out.runId).toMatch(/^run-invoke-planner-/);
    expect(out.sessionId).toMatch(/^planner-invoke-/);

    expect(enqueueRun).toHaveBeenCalledTimes(1);
    const [payload, opts] = enqueueRun.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];

    expect(payload.projectId).toBe("proj-a");
    expect(payload.agentId).toBe("planner");
    expect(payload.userInput).toBe("Do the thing");
    expect(payload.runId).toBe(out.runId);
    expect(payload.sessionId).toBe(out.sessionId);
    expect(payload.sessionContext).toEqual({
      invokedByAgentId: "chat",
      invokedByRunId: "run-chat-1",
      invokedBySessionId: "sess-chat-1",
    });
    expect(opts.priority).toBe(5);
    expect(opts.attempts).toBe(3);
  });

  it("accepts input as alias for goal", async () => {
    const store = mockStoreWithAgents(["planner"]);
    const runner = await setupRegister(store);

    await runner.execute(
      RUNTIME_INVOKE_PLANNER_TOOL_ID,
      { input: "via input" },
      toolCtx({ agentId: "chat" }),
    );

    const [payload] = enqueueRun.mock.calls[0] as [Record<string, unknown>];
    expect(payload.userInput).toBe("via input");
  });

  it("maps priority high/low to BullMQ-style priority numbers", async () => {
    const store = mockStoreWithAgents(["planner"]);
    const runner = await setupRegister(store);

    await runner.execute(
      RUNTIME_INVOKE_PLANNER_TOOL_ID,
      { goal: "g", priority: "high" },
      toolCtx({ agentId: "chat" }),
    );
    expect((enqueueRun.mock.calls[0][1] as { priority: number }).priority).toBe(1);

    await runner.execute(
      RUNTIME_INVOKE_PLANNER_TOOL_ID,
      { goal: "g2", priority: "low" },
      toolCtx({ agentId: "chat" }),
    );
    expect((enqueueRun.mock.calls[1][1] as { priority: number }).priority).toBe(10);
  });

  it("rejects when caller is the planner agent", async () => {
    const store = mockStoreWithAgents(["planner"]);
    const runner = await setupRegister(store);

    await expect(
      runner.execute(
        RUNTIME_INVOKE_PLANNER_TOOL_ID,
        { goal: "x" },
        toolCtx({ agentId: "planner" }),
      ),
    ).rejects.toThrow(/cannot enqueue the planner agent from its own run/);
    expect(enqueueRun).not.toHaveBeenCalled();
  });

  it("rejects empty goal and input", async () => {
    const store = mockStoreWithAgents(["planner"]);
    const runner = await setupRegister(store);

    await expect(
      runner.execute(RUNTIME_INVOKE_PLANNER_TOOL_ID, {}, toolCtx({ agentId: "chat" })),
    ).rejects.toThrow(/goal.*input.*required/);
    expect(enqueueRun).not.toHaveBeenCalled();
  });

  it("throws when custom plannerAgentId is missing from definitions", async () => {
    const store = mockStoreWithAgents(["planner"]);
    const runner = await setupRegister(store);

    await expect(
      runner.execute(
        RUNTIME_INVOKE_PLANNER_TOOL_ID,
        { goal: "x", plannerAgentId: "other-planner" },
        toolCtx({ agentId: "chat" }),
      ),
    ).rejects.toThrow(/not defined for project/);
    expect(enqueueRun).not.toHaveBeenCalled();
  });

  it("seeds default planner via Agent.define when missing and seeding enabled", async () => {
    const listAgents = vi.fn().mockResolvedValue([]);
    const agentDefine = vi.fn().mockResolvedValue(undefined);
    const store = {
      methods: { listAgents },
      Agent: { define: agentDefine },
    } as unknown as DynamicDefinitionsStore;

    const runner = await setupRegister(store);

    await runner.execute(
      RUNTIME_INVOKE_PLANNER_TOOL_ID,
      { goal: "seed test" },
      toolCtx({ agentId: "chat" }),
    );

    expect(listAgents).toHaveBeenCalledWith("proj-a");
    expect(agentDefine).toHaveBeenCalled();
    expect(enqueueRun).toHaveBeenCalledTimes(1);
    const [payload] = enqueueRun.mock.calls[0] as [Record<string, unknown>];
    expect(payload.userInput).toBe("seed test");
  });
});
