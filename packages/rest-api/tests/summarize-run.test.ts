import { describe, expect, it } from "vitest";
import type { Run } from "@opencoreagents/core";
import { summarizeEngineRun } from "../src/summarizeRun.js";

describe("summarizeEngineRun", () => {
  it("uses the last result step in history (continueRun appends a new turn)", () => {
    const run = {
      runId: "r1",
      agentId: "a",
      status: "completed",
      history: [
        { type: "thought", content: "t1", meta: { ts: "1", source: "llm" as const } },
        { type: "result", content: "first answer", meta: { ts: "2", source: "llm" as const } },
        { type: "thought", content: "t2", meta: { ts: "3", source: "llm" as const } },
        { type: "result", content: "second answer", meta: { ts: "4", source: "llm" as const } },
      ],
      state: { iteration: 1, pending: null },
    } as Run;

    const s = summarizeEngineRun(run);
    expect(s.reply).toBe("second answer");
    expect(s.runId).toBe("r1");
    expect(s.status).toBe("completed");
  });
});
