import { describe, it, expect, beforeEach } from "vitest";
import {
  AgentRuntime,
  InMemoryMemoryAdapter,
  clearAllRegistriesForTests,
  dispatchEngineJob,
} from "@opencoreagents/core";
import type { LLMAdapter, LLMRequest, LLMResponse } from "@opencoreagents/core";
import { InMemoryDynamicDefinitionsStore } from "../src/register.js";

class QueueLLM implements LLMAdapter {
  constructor(private readonly queue: string[]) {}
  private i = 0;
  async generate(_req: LLMRequest): Promise<LLMResponse> {
    const content =
      this.queue[this.i++] ??
      JSON.stringify({ type: "result", content: "fallback" });
    return { content };
  }
}

beforeEach(() => {
  clearAllRegistriesForTests();
});

describe("dispatchEngineJob + dynamicDefinitionsStore", () => {
  it("hydrates from store before load when runtime has dynamicDefinitionsStore", async () => {
    const store = new InMemoryDynamicDefinitionsStore();
    await store.methods.saveAgent("p1", {
      id: "store-only",
      projectId: "p1",
      systemPrompt: "From store.",
      tools: [],
      llm: { provider: "openai", model: "gpt-4o" },
    });

    const mem = new InMemoryMemoryAdapter();
    const llm = new QueueLLM([
      JSON.stringify({ type: "thought", content: "t" }),
      JSON.stringify({ type: "result", content: "ok" }),
    ]);
    const rt = new AgentRuntime({
      llmAdapter: llm,
      memoryAdapter: mem,
      maxIterations: 10,
      dynamicDefinitionsStore: store,
    });

    const run = await dispatchEngineJob(rt, {
      kind: "run",
      projectId: "p1",
      agentId: "store-only",
      sessionId: "s1",
      userInput: "hi",
    });

    expect(run.status).toBe("completed");
  });
});
