import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Agent,
  AgentRuntime,
  InMemoryMemoryAdapter,
  clearAllRegistriesForTests,
} from "../src/index.js";

afterEach(() => {
  clearAllRegistriesForTests();
});

describe("dynamicDefinitionsHydrator", () => {
  it("injects environment-specific hydration before dispatch", async () => {
    let generation = 0;
    const store = { kind: "browser-store" };
    const hydrator = vi.fn(async (_store, projectId: string, agentId: string) => {
      await Agent.define({
        id: agentId,
        projectId,
        systemPrompt: "Hydrated agent.",
        tools: [],
        llm: { provider: "local", model: "test-model" },
      });
    });
    const runtime = new AgentRuntime({
      llmAdapter: {
        async generate() {
          generation += 1;
          return {
            content: JSON.stringify(
              generation === 1
                ? { type: "thought", content: "hydrated" }
                : { type: "result", content: "done" },
            ),
          };
        },
      },
      memoryAdapter: new InMemoryMemoryAdapter(),
      dynamicDefinitionsStore: store,
      dynamicDefinitionsHydrator: hydrator,
    });

    const run = await runtime.dispatch({
      kind: "run",
      projectId: "project-1",
      agentId: "agent-1",
      sessionId: "session-1",
      userInput: "hello",
    });

    expect(run.status).toBe("completed");
    expect(hydrator).toHaveBeenCalledWith(store, "project-1", "agent-1", { secrets: {} });
  });
});
