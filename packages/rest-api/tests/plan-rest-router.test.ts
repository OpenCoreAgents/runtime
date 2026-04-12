import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMAdapter, LLMRequest, LLMResponse } from "@opencoreagents/core";
import {
  Agent,
  AgentRuntime,
  clearAllRegistriesForTests,
  InMemoryMemoryAdapter,
  InMemoryRunStore,
} from "@opencoreagents/core";
import { createPlanRestRouter } from "../src/planRestRouter.js";

class TwoStepLlm implements LLMAdapter {
  private i = 0;
  async generate(_req: LLMRequest): Promise<LLMResponse> {
    const content =
      this.i++ === 0
        ? JSON.stringify({ type: "thought", content: "t" })
        : JSON.stringify({ type: "result", content: "ok-from-rest" });
    return { content };
  }
}

describe("createPlanRestRouter", () => {
  beforeEach(() => {
    clearAllRegistriesForTests();
  });

  it("GET /agents and POST /agents/:id/run", async () => {
    const runStore = new InMemoryRunStore();
    const runtime = new AgentRuntime({
      llmAdapter: new TwoStepLlm(),
      memoryAdapter: new InMemoryMemoryAdapter(),
      runStore,
      maxIterations: 10,
    });

    await Agent.define({
      id: "greeter",
      projectId: "p1",
      systemPrompt: "x",
      tools: [],
      llm: { provider: "openai", model: "gpt-4o-mini" },
    });

    const app = express();
    app.use(createPlanRestRouter({
      runtime,
      projectId: "p1",
      agentIds: ["greeter"],
      runStore,
    }));

    const agents = await request(app).get("/agents").expect(200);
    expect(agents.body.agents).toEqual([{ id: "greeter" }]);

    const run = await request(app)
      .post("/agents/greeter/run")
      .send({ message: "hi" })
      .expect(200);

    expect(run.body.status).toBe("completed");
    expect(run.body.reply).toBe("ok-from-rest");
    expect(typeof run.body.sessionId).toBe("string");
    expect(typeof run.body.runId).toBe("string");
  });

  it("returns 401 when apiKey set and header missing", async () => {
    const runtime = new AgentRuntime({
      llmAdapter: new TwoStepLlm(),
      memoryAdapter: new InMemoryMemoryAdapter(),
      maxIterations: 10,
    });
    await Agent.define({
      id: "a",
      projectId: "p1",
      systemPrompt: "x",
      tools: [],
      llm: { provider: "openai", model: "gpt-4o-mini" },
    });

    const app = express();
    app.use(
      createPlanRestRouter({
        runtime,
        projectId: "p1",
        agentIds: ["a"],
        apiKey: "secret",
      }),
    );

    await request(app).get("/agents").expect(401);
    await request(app).get("/agents").set("Authorization", "Bearer secret").expect(200);
  });

  it("without agentIds lists registry agents and accepts run for any of them", async () => {
    const runStore = new InMemoryRunStore();
    const runtime = new AgentRuntime({
      llmAdapter: new TwoStepLlm(),
      memoryAdapter: new InMemoryMemoryAdapter(),
      runStore,
      maxIterations: 10,
    });

    await Agent.define({
      id: "alpha",
      projectId: "p-open",
      systemPrompt: "x",
      tools: [],
      llm: { provider: "openai", model: "gpt-4o-mini" },
    });
    await Agent.define({
      id: "beta",
      projectId: "p-open",
      systemPrompt: "x",
      tools: [],
      llm: { provider: "openai", model: "gpt-4o-mini" },
    });

    const app = express();
    app.use(
      createPlanRestRouter({
        runtime,
        projectId: "p-open",
        runStore,
      }),
    );

    const agents = await request(app).get("/agents").expect(200);
    expect(agents.body.agents.map((a: { id: string }) => a.id).sort()).toEqual([
      "alpha",
      "beta",
    ]);

    await request(app)
      .post("/agents/beta/run")
      .send({ message: "hi" })
      .expect(200);

    await request(app).post("/agents/nope/run").send({ message: "x" }).expect(404);
  });

  it("multi-project: X-Project-Id selects tenant", async () => {
    const runStore = new InMemoryRunStore();
    const runtime = new AgentRuntime({
      llmAdapter: new TwoStepLlm(),
      memoryAdapter: new InMemoryMemoryAdapter(),
      runStore,
      maxIterations: 10,
    });

    await Agent.define({
      id: "bot",
      projectId: "tenant-a",
      systemPrompt: "x",
      tools: [],
      llm: { provider: "openai", model: "gpt-4o-mini" },
    });
    await Agent.define({
      id: "bot",
      projectId: "tenant-b",
      systemPrompt: "x",
      tools: [],
      llm: { provider: "openai", model: "gpt-4o-mini" },
    });

    const app = express();
    app.use(
      createPlanRestRouter({
        runtime,
        allowedProjectIds: ["tenant-a", "tenant-b"],
        runStore,
      }),
    );

    await request(app).get("/agents").expect(400);

    const a = await request(app).get("/agents").set("X-Project-Id", "tenant-a").expect(200);
    expect(a.body.projectId).toBe("tenant-a");
    expect(a.body.agents).toEqual([{ id: "bot" }]);

    const b = await request(app).get("/agents?projectId=tenant-b").expect(200);
    expect(b.body.projectId).toBe("tenant-b");

    await request(app)
      .get("/agents")
      .set("X-Project-Id", "other")
      .expect(403);

    await request(app)
      .post("/agents/bot/run")
      .send({ projectId: "tenant-a", message: "hi" })
      .expect(200);
  });

  it("allowedProjectIds [\"*\"] accepts any resolved project", async () => {
    const runtime = new AgentRuntime({
      llmAdapter: new TwoStepLlm(),
      memoryAdapter: new InMemoryMemoryAdapter(),
      maxIterations: 10,
    });

    await Agent.define({
      id: "x",
      projectId: "dynamic-tenant-99",
      systemPrompt: "x",
      tools: [],
      llm: { provider: "openai", model: "gpt-4o-mini" },
    });

    const app = express();
    app.use(
      createPlanRestRouter({
        runtime,
        allowedProjectIds: ["*"],
      }),
    );

    const agents = await request(app)
      .get("/agents")
      .set("X-Project-Id", "dynamic-tenant-99")
      .expect(200);
    expect(agents.body.projectId).toBe("dynamic-tenant-99");
    expect(agents.body.agents).toEqual([{ id: "x" }]);

    await request(app)
      .get("/agents")
      .set("X-Project-Id", "not-defined-but-allowed")
      .expect(200);
  });

  it("throws if neither runtime nor dispatch", () => {
    expect(() => createPlanRestRouter({ projectId: "p" } as never)).toThrow(/runtime.*dispatch/);
  });

  it("dispatch: POST run returns 202 and GET /jobs polls", async () => {
    await Agent.define({
      id: "qagent",
      projectId: "pq",
      systemPrompt: "x",
      tools: [],
      llm: { provider: "openai", model: "gpt-4o-mini" },
    });

    const finishedRun = {
      runId: "run-from-worker",
      agentId: "qagent",
      status: "completed" as const,
      history: [
        {
          type: "result" as const,
          content: "queued-ok",
          meta: { ts: new Date().toISOString(), source: "llm" as const },
        },
      ],
      state: { iteration: 1, pending: null },
    };

    const addRun = vi.fn().mockResolvedValue({
      id: "job-xyz",
      waitUntilFinished: vi.fn(),
      returnvalue: undefined,
    });
    const getJob = vi.fn().mockResolvedValue({
      id: "job-xyz",
      getState: async () => "completed",
      failedReason: undefined,
      returnvalue: finishedRun,
    });
    const engine = {
      queue: { getJob },
      addRun,
      addResume: vi.fn(),
    };

    const app = express();
    app.use(
      "/api",
      createPlanRestRouter({
        dispatch: { engine: engine as never },
        projectId: "pq",
      }),
    );

    const run = await request(app)
      .post("/api/agents/qagent/run")
      .send({ message: "hi" })
      .expect(202);

    expect(run.body.jobId).toBe("job-xyz");
    expect(run.body.statusUrl).toBe("/api/jobs/job-xyz");
    expect(addRun).toHaveBeenCalledWith({
      projectId: "pq",
      agentId: "qagent",
      sessionId: expect.any(String),
      userInput: "hi",
    });

    const job = await request(app).get("/api/jobs/job-xyz").expect(200);
    expect(job.body.state).toBe("completed");
    expect(job.body.run).toEqual({
      status: "completed",
      runId: "run-from-worker",
      reply: "queued-ok",
    });
  });

  it("dispatch: wait=1 without queueEvents returns 501", async () => {
    await Agent.define({
      id: "w",
      projectId: "pw",
      systemPrompt: "x",
      tools: [],
      llm: { provider: "openai", model: "gpt-4o-mini" },
    });

    const addRun = vi.fn().mockResolvedValue({ id: "j1", waitUntilFinished: vi.fn() });
    const engine = {
      queue: { getJob: vi.fn() },
      addRun,
      addResume: vi.fn(),
    };

    const app = express();
    app.use(
      createPlanRestRouter({
        dispatch: { engine: engine as never },
        projectId: "pw",
      }),
    );

    await request(app).post("/agents/w/run?wait=1").send({ message: "x" }).expect(501);
  });

  it("swagger: GET /openapi.json and /docs skip apiKey and tenant middleware", async () => {
    const runStore = new InMemoryRunStore();
    const runtime = new AgentRuntime({
      llmAdapter: new TwoStepLlm(),
      memoryAdapter: new InMemoryMemoryAdapter(),
      runStore,
      maxIterations: 10,
    });
    await Agent.define({
      id: "a",
      projectId: "p1",
      systemPrompt: "x",
      tools: [],
      llm: { provider: "openai", model: "gpt-4o-mini" },
    });

    const app = express();
    app.use(
      createPlanRestRouter({
        runtime,
        projectId: "p1",
        agentIds: ["a"],
        runStore,
        apiKey: "secret",
        swagger: true,
      }),
    );

    const spec = await request(app).get("/openapi.json").expect(200);
    expect(spec.body).toMatchObject({ openapi: "3.0.3" });
    expect(spec.body.paths).toHaveProperty("/agents");

    const docs = await request(app).get("/docs").expect(200);
    expect(docs.text).toContain("SwaggerUIBundle");
    expect(docs.text).toContain("openapi.json");

    await request(app).get("/agents").expect(401);
  });

  it("swagger: custom paths under mount resolve openApi file name in HTML", async () => {
    const runtime = new AgentRuntime({
      llmAdapter: new TwoStepLlm(),
      memoryAdapter: new InMemoryMemoryAdapter(),
      maxIterations: 10,
    });
    await Agent.define({
      id: "a",
      projectId: "p1",
      systemPrompt: "x",
      tools: [],
      llm: { provider: "openai", model: "gpt-4o-mini" },
    });

    const app = express();
    app.use(
      "/api",
      createPlanRestRouter({
        runtime,
        projectId: "p1",
        agentIds: ["a"],
        swagger: { openApiPath: "spec.json", uiPath: "api-docs" },
      }),
    );

    const spec = await request(app).get("/api/spec.json").expect(200);
    expect(spec.body.openapi).toBe("3.0.3");

    const docs = await request(app).get("/api/api-docs").expect(200);
    expect(docs.text).toContain("spec.json");
    expect(docs.text).toContain("/api-docs");
  });
});
