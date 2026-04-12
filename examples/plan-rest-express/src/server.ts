/**
 * After `Agent.define`, mount **`createPlanRestRouter`** — same routes as **`docs/plan-rest.md`** (minimal subset).
 */
import express from "express";
import type { LLMAdapter, LLMRequest, LLMResponse } from "@opencoreagents/core";
import {
  Agent,
  AgentRuntime,
  InMemoryMemoryAdapter,
  InMemoryRunStore,
} from "@opencoreagents/core";
import { createPlanRestRouter } from "@opencoreagents/rest-api";

class DeterministicDemoLlm implements LLMAdapter {
  private i = 0;
  async generate(_req: LLMRequest): Promise<LLMResponse> {
    const content =
      this.i++ === 0
        ? JSON.stringify({ type: "thought", content: "Plan greeting." })
        : JSON.stringify({
            type: "result",
            content: "Hello from plan-rest-express + @opencoreagents/rest-api.",
          });
    return { content };
  }
}

const PROJECT_ID = "plan-rest-demo";
const PORT = Number(process.env.PORT) || 3050;

const runStore = new InMemoryRunStore();
const runtime = new AgentRuntime({
  llmAdapter: new DeterministicDemoLlm(),
  memoryAdapter: new InMemoryMemoryAdapter(),
  runStore,
  maxIterations: 10,
});

await Agent.define({
  id: "demo-greeter",
  projectId: PROJECT_ID,
  systemPrompt: "You are a helpful assistant.",
  tools: [],
  llm: { provider: "openai", model: "gpt-4o-mini" },
});

const app = express();
app.disable("x-powered-by");
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "plan-rest-express" });
});

app.use(
  createPlanRestRouter({
    runtime,
    projectId: PROJECT_ID,
    runStore,
    apiKey: process.env.REST_API_KEY?.trim() || undefined,
  }),
);

app.listen(PORT, () => {
  console.log(`http://127.0.0.1:${PORT}  GET /agents  POST /agents/demo-greeter/run`);
  console.log(
    process.env.REST_API_KEY
      ? "REST_API_KEY set — send Authorization: Bearer … or X-Api-Key"
      : "REST_API_KEY unset — /agents open",
  );
});
