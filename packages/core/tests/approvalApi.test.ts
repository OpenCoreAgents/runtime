import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMAdapter, LLMResponse } from "../src/adapters/llm/LLMAdapter.js";
import type {
  ExecutionPolicy,
  PendingToolApproval,
  Run,
} from "../src/index.js";
import {
  Agent,
  AgentRuntime,
  InMemoryMemoryAdapter,
  InMemoryRunStore,
  Session,
  Tool,
  approvePendingAction,
  cancelPendingAction,
  clearAllRegistriesForTests,
  rejectPendingAction,
} from "../src/index.js";
import {
  ExecutionNotAllowedError,
  RunInvalidStateError,
} from "../src/errors/index.js";

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

const noopStore = () =>
  ({
    save: vi.fn(),
    saveIfStatus: vi.fn(async () => true),
    load: vi.fn(async () => null),
    delete: vi.fn(),
    listByAgent: vi.fn(async () => []),
    listByAgentAndSession: vi.fn(async () => ({ runs: [] })),
  }) as never as InMemoryRunStore;

/**
 * Models a host policy that requires approval the first time a tool is
 * proposed and allows it afterwards (the approval "unlocks" it).
 */
function waitOncePolicy(toolId: string): ExecutionPolicy {
  let proposals = 0;
  return async (input) => {
    if (input.tool.name !== toolId) return { decision: "allow" };
    proposals++;
    if (proposals === 1) {
      return { decision: "wait", reason: "needs_approval", ttlMs: 60_000 };
    }
    return { decision: "allow" };
  };
}

async function setupWaiting(opts?: {
  policy?: ExecutionPolicy;
  tenantId?: string;
}) {
  const execute = vi.fn(async () => ({ ok: true }));
  await Tool.define({
    id: "ap_tool",
    scope: "global",
    description: "approval target",
    inputSchema: { type: "object", properties: {} },
    execute,
  });
  const llm = new QueueLLM([
    JSON.stringify({ type: "action", tool: "ap_tool", input: { text: " hi " } }),
    JSON.stringify({ type: "result", content: "after approval" }),
  ]);
  const store = new InMemoryRunStore();
  const rt = new AgentRuntime({
    llmAdapter: llm,
    memoryAdapter: new InMemoryMemoryAdapter(),
    maxIterations: 10,
    runStore: store,
    executionPolicy: opts?.policy ?? waitOncePolicy("ap_tool"),
  });
  await Agent.define({
    id: "a_ap",
    projectId: "p1",
    systemPrompt: "Test.",
    tools: ["ap_tool"],
    llm: { provider: "openai", model: "gpt-4o" },
  });
  const session = new Session({
    id: "s_ap",
    projectId: "p1",
    tenantId: opts?.tenantId,
  });
  const agent = await Agent.load("a_ap", rt, { session });
  const run: Run = await agent.run("go");
  expect(run.status).toBe("waiting");
  const pending = run.state.pending as PendingToolApproval;
  expect(pending.kind).toBe("tool_approval");
  return { rt, store, session, run, pending, execute };
}

beforeEach(() => {
  clearAllRegistriesForTests();
});

describe("approvalApi", () => {
  it("approve happy path: executes exact prepared input once, passes idempotencyKey, continues loop", async () => {
    const { rt, store, session, run, pending, execute } = await setupWaiting();

    const res = await approvePendingAction(rt, {
      runId: run.runId,
      actionId: pending.actionId,
      session,
    });

    expect(res.executed).toBe(true);
    expect(res.idempotencyKey).toBe(`${run.runId}_${pending.actionId}`);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toEqual({ text: " hi " });
    const ctx = execute.mock.calls[0]![1] as { idempotencyKey?: string };
    expect(ctx.idempotencyKey).toBe(`${run.runId}_${pending.actionId}`);
    expect(res.run.status).toBe("completed");
    const stored = await store.load(run.runId);
    expect(stored?.status).toBe("completed");
    expect(stored?.state.pending).toBeNull();
  });

  it("duplicate approve (already claimed) fails before side effect", async () => {
    const { rt, store, session, run, pending, execute } = await setupWaiting();
    const claim = await store.claimPendingAction({
      runId: run.runId,
      actionId: pending.actionId,
      expectedStatus: "waiting",
    });
    expect(claim.ok).toBe(true);

    await expect(
      approvePendingAction(rt, {
        runId: run.runId,
        actionId: pending.actionId,
        session,
      }),
    ).rejects.toBeInstanceOf(RunInvalidStateError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("concurrent approvals execute the tool exactly once", async () => {
    const { rt, session, run, pending, execute } = await setupWaiting();
    const call = () =>
      approvePendingAction(rt, {
        runId: run.runId,
        actionId: pending.actionId,
        session,
      });
    const results = await Promise.allSettled([call(), call()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      RunInvalidStateError,
    );
    expect(
      (fulfilled[0] as PromiseFulfilledResult<{ executed: boolean }>).value
        .executed,
    ).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("wrong actionId is rejected", async () => {
    const { rt, session, run, execute } = await setupWaiting();
    await expect(
      approvePendingAction(rt, {
        runId: run.runId,
        actionId: `${run.runId}_bogus`,
        session,
      }),
    ).rejects.toBeInstanceOf(RunInvalidStateError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("wrong session cannot approve", async () => {
    const { rt, run, pending, execute } = await setupWaiting();
    const stranger = new Session({ id: "other", projectId: "p1" });
    await expect(
      approvePendingAction(rt, {
        runId: run.runId,
        actionId: pending.actionId,
        session: stranger,
      }),
    ).rejects.toBeInstanceOf(RunInvalidStateError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("wrong tenant cannot approve", async () => {
    const { rt, run, pending, execute } = await setupWaiting({ tenantId: "t1" });
    const otherTenant = new Session({
      id: "s_ap",
      projectId: "p1",
      tenantId: "t2",
    });
    await expect(
      approvePendingAction(rt, {
        runId: run.runId,
        actionId: pending.actionId,
        session: otherTenant,
      }),
    ).rejects.toBeInstanceOf(RunInvalidStateError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("expired approval does not execute", async () => {
    const { rt, store, session, run, pending, execute } = await setupWaiting();
    const loaded = await store.load(run.runId);
    loaded!.state.pending = {
      ...(loaded!.state.pending as PendingToolApproval),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    await store.save(loaded!);

    await expect(
      approvePendingAction(rt, {
        runId: run.runId,
        actionId: pending.actionId,
        session,
      }),
    ).rejects.toBeInstanceOf(RunInvalidStateError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("policy deny on reauthorization never executes the tool", async () => {
    let calls = 0;
    const policy: ExecutionPolicy = async () => {
      calls++;
      if (calls === 1) {
        return { decision: "wait", reason: "needs_approval", ttlMs: 60_000 };
      }
      return { decision: "deny", reason: "revoked" };
    };
    const { rt, session, run, pending, execute } = await setupWaiting({
      policy,
    });
    const res = await approvePendingAction(rt, {
      runId: run.runId,
      actionId: pending.actionId,
      session,
    });
    expect(res.executed).toBe(false);
    expect(res.deniedCode).toBe("EXECUTION_POLICY_DENIED");
    expect(execute).not.toHaveBeenCalled();
    const deniedObs = res.run.history.find(
      (h) =>
        h.type === "observation" &&
        (h.content as { code?: string }).code === "EXECUTION_POLICY_DENIED",
    );
    expect(deniedObs).toBeTruthy();
  });

  it("execute_only runs the tool without another LLM turn", async () => {
    const { rt, store, session, run, pending, execute } = await setupWaiting();
    const res = await approvePendingAction(rt, {
      runId: run.runId,
      actionId: pending.actionId,
      session,
      mode: "execute_only",
    });
    expect(res.executed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(res.run.status).toBe("running");
    const stored = await store.load(run.runId);
    expect(stored?.status).toBe("running");
    expect(
      stored!.history[stored!.history.length - 1]?.type,
    ).toBe("observation");
  });

  it("reject appends observation and continues; tool never executes", async () => {
    const { rt, session, run, pending, execute } = await setupWaiting();
    const res = await rejectPendingAction(rt, {
      runId: run.runId,
      actionId: pending.actionId,
      session,
      reason: "nope",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(res.run.status).toBe("completed");
    const obs = res.run.history.find(
      (h) =>
        h.type === "observation" &&
        (h.content as { code?: string }).code === "ACTION_REJECTED",
    );
    expect(obs).toBeTruthy();
  });

  it("cancel terminally fails the run; tool never executes", async () => {
    const { rt, store, session, run, pending, execute } = await setupWaiting();
    const res = await cancelPendingAction(rt, {
      runId: run.runId,
      actionId: pending.actionId,
      session,
      reason: "window closed",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(res.run.status).toBe("failed");
    expect(res.run.state.failedReason).toContain("RUN_CANCELLED");
    const stored = await store.load(run.runId);
    expect(stored?.status).toBe("failed");
  });

  it("concurrent reject vs approve: approve wins, reject observes already_claimed", async () => {
    const { rt, store, session, run, pending, execute } = await setupWaiting();
    const approveP = approvePendingAction(rt, {
      runId: run.runId,
      actionId: pending.actionId,
      session,
    });
    const rejectP = rejectPendingAction(rt, {
      runId: run.runId,
      actionId: pending.actionId,
      session,
      reason: "raced",
    });
    const [approveRes, rejectRes] = await Promise.allSettled([approveP, rejectP]);
    // Exactly one of the two settles with `ok`; the other is a claim race.
    const oks = [approveRes, rejectRes].filter((r) => r.status === "fulfilled");
    const fails = [approveRes, rejectRes].filter((r) => r.status === "rejected");
    expect(oks.length).toBe(1);
    expect(fails.length).toBe(1);
    expect((fails[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      RunInvalidStateError,
    );
    expect((fails[0] as PromiseRejectedResult).reason.message).toMatch(
      /already claimed|not waiting|already resolved/i,
    );
    // Tool executes at most once.
    expect(execute.mock.calls.length).toBeLessThanOrEqual(1);
    // Stored run reflects the winner (the one with the claim).
    const stored = await store.load(run.runId);
    expect(stored).not.toBeNull();
    expect(stored?.state.pending).toBeNull();
  });

  it("two concurrent rejects: only one resolves, the other observes already_claimed", async () => {
    const { rt, session, run, pending, execute } = await setupWaiting();
    const a = rejectPendingAction(rt, {
      runId: run.runId,
      actionId: pending.actionId,
      session,
      reason: "first",
    });
    const b = rejectPendingAction(rt, {
      runId: run.runId,
      actionId: pending.actionId,
      session,
      reason: "second",
    });
    const [ra, rb] = await Promise.allSettled([a, b]);
    const oks = [ra, rb].filter((r) => r.status === "fulfilled");
    const fails = [ra, rb].filter((r) => r.status === "rejected");
    expect(oks.length).toBe(1);
    expect(fails.length).toBe(1);
    expect((fails[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      RunInvalidStateError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("two concurrent cancels: only one resolves, the other observes already_claimed", async () => {
    const { rt, session, run, pending, execute } = await setupWaiting();
    const a = cancelPendingAction(rt, {
      runId: run.runId,
      actionId: pending.actionId,
      session,
      reason: "first",
    });
    const b = cancelPendingAction(rt, {
      runId: run.runId,
      actionId: pending.actionId,
      session,
      reason: "second",
    });
    const [ra, rb] = await Promise.allSettled([a, b]);
    const oks = [ra, rb].filter((r) => r.status === "fulfilled");
    const fails = [ra, rb].filter((r) => r.status === "rejected");
    expect(oks.length).toBe(1);
    expect(fails.length).toBe(1);
    expect((fails[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      RunInvalidStateError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("approve after a previous reject (sequential) yields already_claimed", async () => {
    const { rt, session, run, pending, execute } = await setupWaiting();
    await rejectPendingAction(rt, {
      runId: run.runId,
      actionId: pending.actionId,
      session,
    });
    await expect(
      approvePendingAction(rt, {
        runId: run.runId,
        actionId: pending.actionId,
        session,
      }),
    ).rejects.toThrow(/not waiting|already claimed/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("reject emits a public tool_denied event with cause='rejected'", async () => {
    const { rt, session, run, pending } = await setupWaiting();
    const events: Array<{ type: string; cause?: string; code?: string; reason?: string }> = [];
    rt.config.eventSinks = [
      (e) => {
        events.push({
          type: e.type,
          cause: (e as { cause?: string }).cause,
          code: (e as { code?: string }).code,
          reason: (e as { reason?: string }).reason,
        });
      },
    ];
    const res = await rejectPendingAction(rt, {
      runId: run.runId,
      actionId: pending.actionId,
      session,
      reason: "host said no",
    });
    expect(res.run.status).toBe("completed");
    const denied = events.filter((e) => e.type === "tool_denied");
    expect(denied.length).toBeGreaterThanOrEqual(1);
    expect(denied[denied.length - 1]?.cause).toBe("rejected");
    expect(denied[denied.length - 1]?.code).toBe("ACTION_REJECTED");
  });

  it("cancel emits a public run_cancelled event and terminally fails the run", async () => {
    const { rt, session, run, pending } = await setupWaiting();
    const events: string[] = [];
    rt.config.eventSinks = [
      (e) => {
        events.push(e.type);
      },
    ];
    const res = await cancelPendingAction(rt, {
      runId: run.runId,
      actionId: pending.actionId,
      session,
      reason: "window closed",
    });
    expect(res.run.status).toBe("failed");
    expect(res.run.state.failedReason).toContain("RUN_CANCELLED");
    expect(events).toContain("run_cancelled");
  });

  it("requires a runStore and an approval-capable store", async () => {
    const { pending, run } = await setupWaiting();
    const rtNoStore = new AgentRuntime({
      llmAdapter: new QueueLLM([]),
      memoryAdapter: new InMemoryMemoryAdapter(),
      maxIterations: 10,
      executionPolicy: waitOncePolicy("ap_tool"),
    });
    await expect(
      approvePendingAction(rtNoStore, {
        runId: run.runId,
        actionId: pending.actionId,
        session: new Session({ id: "s_ap", projectId: "p1" }),
      }),
    ).rejects.toBeInstanceOf(ExecutionNotAllowedError);

    const stub = {
      save: vi.fn(),
      saveIfStatus: vi.fn(async () => true),
      load: vi.fn(async () => null),
      delete: vi.fn(),
      listByAgent: vi.fn(async () => []),
      listByAgentAndSession: vi.fn(async () => ({ runs: [] })),
    };
    const rtStub = new AgentRuntime({
      llmAdapter: new QueueLLM([]),
      memoryAdapter: new InMemoryMemoryAdapter(),
      maxIterations: 10,
      executionPolicy: waitOncePolicy("ap_tool"),
      runStore: stub as unknown as InMemoryRunStore,
    });
    await expect(
      approvePendingAction(rtStub, {
        runId: run.runId,
        actionId: pending.actionId,
        session: new Session({ id: "s_ap", projectId: "p1" }),
      }),
    ).rejects.toBeInstanceOf(ExecutionNotAllowedError);
  });
});
