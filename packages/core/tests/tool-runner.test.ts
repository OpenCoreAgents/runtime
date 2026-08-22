import { describe, it, expect, vi } from "vitest";
import { ToolRunner } from "../src/tools/ToolRunner.js";
import type { ToolAdapter, ToolContext } from "../src/adapters/tool/ToolAdapter.js";
import {
  ToolExecutionError,
  ToolNotAllowedError,
  ToolPreparationError,
  ToolTimeoutError,
  ToolValidationError,
} from "../src/errors/index.js";
import { InMemoryMemoryAdapter } from "../src/adapters/memory/InMemoryMemoryAdapter.js";

const ctxBase = (): ToolContext => ({
  projectId: "p1",
  agentId: "a1",
  runId: "r1",
  sessionId: "s1",
  memoryAdapter: new InMemoryMemoryAdapter(),
  securityContext: {
    principalId: "internal",
    kind: "internal",
    organizationId: "p1",
    projectId: "p1",
    roles: ["agent"],
    scopes: ["*"],
  },
});

describe("ToolRunner", () => {
  it("completes fast tools without timeout option", async () => {
    const tool: ToolAdapter = {
      name: "ok",
      async execute() {
        return { x: 1 };
      },
    };
    const runner = new ToolRunner(new Map([["ok", tool]]), new Set(["ok"]));
    const out = await runner.execute("ok", {}, ctxBase());
    expect(out).toEqual({ x: 1 });
  });

  it("rejects when tool exceeds toolTimeoutMs", async () => {
    const tool: ToolAdapter = {
      name: "slow",
      async execute() {
        await new Promise((r) => setTimeout(r, 200));
        return { ok: true };
      },
    };
    const runner = new ToolRunner(new Map([["slow", tool]]), new Set(["slow"]), {
      toolTimeoutMs: 30,
    });
    await expect(runner.execute("slow", {}, ctxBase())).rejects.toThrow(ToolTimeoutError);
  });

  it("includes validation reason when a tool returns structured validation failure", async () => {
    const tool: ToolAdapter = {
      name: "mem",
      validate() {
        return { ok: false, reason: "memoryType must be one of shortTerm, longTerm, working" };
      },
      async execute() {
        return { ok: true };
      },
    };
    const runner = new ToolRunner(new Map([["mem", tool]]), new Set(["mem"]));
    await expect(runner.execute("mem", {}, ctxBase())).rejects.toThrow(
      /memoryType must be one of shortTerm, longTerm, working/,
    );
    await expect(runner.execute("mem", {}, ctxBase())).rejects.toBeInstanceOf(ToolValidationError);
  });

  it("legacy tool with validate success executes", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const tool: ToolAdapter = {
      name: "legacy",
      validate() {
        return { ok: true };
      },
      execute,
    };
    const runner = new ToolRunner(new Map([["legacy", tool]]), new Set(["legacy"]));
    const out = await runner.execute("legacy", { n: 1 }, ctxBase());
    expect(out).toEqual({ ok: true });
    expect(execute).toHaveBeenCalledWith({ n: 1 }, ctxBase());
  });

  it("legacy tool with failed validation does not execute", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const tool: ToolAdapter = {
      name: "legacy-fail",
      validate() {
        return { ok: false, reason: "missing field" };
      },
      execute,
    };
    const runner = new ToolRunner(new Map([["legacy-fail", tool]]), new Set(["legacy-fail"]));
    await expect(runner.execute("legacy-fail", {}, ctxBase())).rejects.toBeInstanceOf(
      ToolValidationError,
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it("prepareInput transforms raw input and execute receives the prepared value", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const tool: ToolAdapter = {
      name: "canonical",
      prepareInput(rawInput) {
        const value = typeof rawInput === "string" ? { text: rawInput.trim() } : rawInput;
        return { ok: true, value };
      },
      execute,
    };
    const runner = new ToolRunner(new Map([["canonical", tool]]), new Set(["canonical"]));
    const out = await runner.execute("canonical", " hello ", ctxBase());
    expect(out).toEqual({ ok: true });
    expect(execute).toHaveBeenCalledWith({ text: "hello" }, ctxBase());
  });


  it("prepareInput can apply defaults and coercion", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const tool: ToolAdapter = {
      name: "coerce",
      prepareInput(rawInput) {
        const input = rawInput as Record<string, unknown>;
        return {
          ok: true,
          value: {
            count: typeof input.count === "string" ? Number(input.count) : input.count ?? 0,
            enabled: input.enabled ?? false,
          },
        };
      },
      execute,
    };
    const runner = new ToolRunner(new Map([["coerce", tool]]), new Set(["coerce"]));
    await runner.execute("coerce", { count: "42" }, ctxBase());
    expect(execute).toHaveBeenCalledWith({ count: 42, enabled: false }, ctxBase());
  });

  it("failed prepareInput does not execute", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const tool: ToolAdapter = {
      name: "prep-fail",
      prepareInput() {
        return { ok: false, reason: "unsupported shape" };
      },
      execute,
    };
    const runner = new ToolRunner(new Map([["prep-fail", tool]]), new Set(["prep-fail"]));
    await expect(runner.execute("prep-fail", {}, ctxBase())).rejects.toBeInstanceOf(
      ToolPreparationError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not call prepareInput for a disallowed tool", async () => {
    const prepareInput = vi.fn().mockResolvedValue({ ok: true, value: {} });
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const tool: ToolAdapter = {
      name: "blocked",
      prepareInput,
      execute,
    };
    const runner = new ToolRunner(new Map([["blocked", tool]]), new Set(["allowed"]));
    await expect(runner.execute("blocked", {}, ctxBase())).rejects.toBeInstanceOf(
      ToolNotAllowedError,
    );
    expect(prepareInput).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not call prepareInput for an unknown tool", async () => {
    const runner = new ToolRunner(new Map(), new Set(["missing"]));
    await expect(runner.execute("missing", {}, ctxBase())).rejects.toBeInstanceOf(
      ToolExecutionError,
    );
  });

  it("async prepareInput is awaited", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const tool: ToolAdapter = {
      name: "async-prep",
      async prepareInput(rawInput) {
        await new Promise((r) => setTimeout(r, 10));
        return { ok: true, value: { ...(rawInput as object), async: true } };
      },
      execute,
    };
    const runner = new ToolRunner(new Map([["async-prep", tool]]), new Set(["async-prep"]));
    const out = await runner.execute("async-prep", { x: 1 }, ctxBase());
    expect(out).toEqual({ ok: true });
    expect(execute).toHaveBeenCalledWith({ x: 1, async: true }, ctxBase());
  });

  it("prepare returns a failure action before execution", async () => {
    const tool: ToolAdapter = {
      name: "prep-only",
      prepareInput() {
        return { ok: false, reason: "bad" };
      },
      async execute() {
        return { ok: true };
      },
    };
    const runner = new ToolRunner(new Map([["prep-only", tool]]), new Set(["prep-only"]));
    const prepared = await runner.prepare("prep-only", {});
    expect(prepared).toEqual({
      ok: false,
      toolName: "prep-only",
      reason: "Preparation failed for tool: prep-only: bad",
      kind: "preparation",
    });
  });

  it("executePrepared throws the correct error for a failure action", async () => {
    const tool: ToolAdapter = {
      name: "x",
      async execute() {
        return { ok: true };
      },
    };
    const runner = new ToolRunner(new Map([["x", tool]]), new Set(["allowed"]));
    const prepared = await runner.prepare("x", {});
    await expect(runner.executePrepared(prepared, ctxBase())).rejects.toBeInstanceOf(
      ToolNotAllowedError,
    );
  });

  it("prepare includes preparedInput when successful", async () => {
    const tool: ToolAdapter = {
      name: "inspect",
      prepareInput(rawInput) {
        return { ok: true, value: { canonical: rawInput } };
      },
      async execute() {
        return { ok: true };
      },
    };
    const runner = new ToolRunner(new Map([["inspect", tool]]), new Set(["inspect"]));
    const prepared = await runner.prepare("inspect", { raw: 1 });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.preparedInput).toEqual({ canonical: { raw: 1 } });
      expect(prepared.rawInput).toEqual({ raw: 1 });
    }
  });

  it("prepareInput takes precedence over validate when both are defined", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const tool: ToolAdapter = {
      name: "both",
      prepareInput(rawInput) {
        return { ok: true, value: { prepared: rawInput } };
      },
      validate() {
        return { ok: false, reason: "should not run" };
      },
      execute,
    };
    const runner = new ToolRunner(new Map([["both", tool]]), new Set(["both"]));
    const out = await runner.execute("both", { x: 1 }, ctxBase());
    expect(out).toEqual({ ok: true });
    expect(execute).toHaveBeenCalledWith({ prepared: { x: 1 } }, ctxBase());
  });

});
