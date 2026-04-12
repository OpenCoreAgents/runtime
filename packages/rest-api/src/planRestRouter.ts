import { randomUUID } from "node:crypto";
import express, { type Request, type RequestHandler, type Response, type Router } from "express";
import type { EngineQueue } from "@opencoreagents/adapters-bullmq";
import type { QueueEvents } from "bullmq";
import {
  Agent,
  Session,
  getAgentDefinition,
  listAgentIdsForProject,
  type AgentRuntime,
  type Run,
  type RunStore,
} from "@opencoreagents/core";
import type { PlanRestSwaggerOptions } from "./openapi.js";
import {
  buildPlanRestOpenApiSpec,
  normalizePlanRestSwaggerPaths,
  planRestSwaggerInfo,
  planRestSwaggerUiHtml,
} from "./openapi.js";
import { summarizeEngineRun } from "./summarizeRun.js";

/** BullMQ enqueue path — same payload shape as **`examples/dynamic-runtime-rest`** (`addRun` / `addResume`). */
export interface PlanRestDispatchOptions {
  engine: EngineQueue;
  /**
   * **`QueueEvents`** for the **same** queue name as **`engine`** — required when clients use **`?wait=1`**
   * or JSON **`"wait": true`** (blocking until the worker finishes the job).
   */
  queueEvents?: QueueEvents;
  /** **`waitUntilFinished`** timeout when **`wait`** is set (default **120_000** ms). */
  jobWaitTimeoutMs?: number;
}

export interface PlanRestPluginOptions {
  /**
   * Used for **inline** **`Agent.run` / `resume`** when **`dispatch`** is unset.
   * When **`dispatch`** is set, **`runtime`** is optional (worker process owns **`AgentRuntime.dispatch`**).
   */
  runtime?: AgentRuntime;
  /**
   * When set, **`POST …/run`** and **`POST …/resume`** **enqueue** via **`engine.addRun` / `addResume`**
   * (async worker — configure **`AgentRuntime`** + **`dispatch`** on the worker like **`dynamic-runtime-rest`**).
   * Responses default to **202** + **`jobId`** + **`statusUrl`**; use **`?wait=1`** or **`"wait": true`** in the body to block (needs **`queueEvents`**).
   */
  dispatch?: PlanRestDispatchOptions;
  /**
   * Fixed tenant: every request uses this **`Session.projectId`** (clients cannot override).
   * Omit for **multi-project** mode: resolve per request via **`resolveProjectId`**
   * (default: header **`X-Project-Id`**, then **`?projectId=`**, then **`body.projectId`** on POST JSON).
   */
  projectId?: string;
  /**
   * When set (non-empty), only these **`projectId`** values are accepted (fixed or resolved).
   * Include **`"*"`** as the sole entry (or alongside others) to allow **any** resolved project id
   * while still using per-request resolution — pair with **`apiKey`** / **`resolveProjectId`** in production.
   */
  allowedProjectIds?: readonly string[];
  /**
   * Override how the tenant is chosen when **`projectId`** is omitted.
   * Return a non-empty string, or **`undefined`** / empty to yield **400**.
   */
  resolveProjectId?: (req: Request) => string | undefined;
  /**
   * Optional allowlist: only these ids appear on **`GET /agents`** and are accepted on run/resume.
   * If omitted, any agent resolvable for the effective project (project registry + global agents) is allowed;
   * **`GET /agents`** lists ids from the in-process registry (same rules as **`Agent.load`**).
   */
  agentIds?: readonly string[];
  /**
   * Required for **inline** **`POST …/resume`** and **`GET /runs/:runId`**.
   * Omit on the API when only **`dispatch`** handles run/resume (worker owns **`RunStore`**).
   */
  runStore?: RunStore;
  /** If set, require `Authorization: Bearer <key>` or `X-Api-Key: <key>`. */
  apiKey?: string;
  /**
   * Expose **OpenAPI JSON** + **Swagger UI** on the same router (no extra npm deps — UI loads from **unpkg**).
   * Routes are registered **before** API key and tenant middleware so **`GET /docs`** and **`GET /openapi.json`**
   * do not require **`X-Project-Id`** or auth (add your own **`app.use`** if you need to lock them down).
   */
  swagger?: boolean | PlanRestSwaggerOptions;
}

const localsKey = "planRestProjectId" as const;

function getPlanRestProjectId(res: Response): string {
  const id = (res.locals as Record<string, string | undefined>)[localsKey];
  if (!id) throw new Error("planRestProjectId missing (middleware order)");
  return id;
}

/** Default tenant resolution when `options.projectId` is omitted. */
export function defaultPlanRestResolveProjectId(req: Request): string | undefined {
  const h = req.header("x-project-id")?.trim();
  if (h) return h;
  const q = req.query.projectId;
  if (typeof q === "string" && q.trim()) return q.trim();
  const body = req.body;
  if (
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    typeof (body as { projectId?: unknown }).projectId === "string"
  ) {
    const p = (body as { projectId: string }).projectId.trim();
    if (p) return p;
  }
  return undefined;
}

function resultText(run: Run): string | undefined {
  const last = run.history.filter((h) => h.type === "result").pop();
  return last && typeof last.content === "string" ? last.content : undefined;
}

function optionalApiKeyAuth(apiKey: string | undefined): RequestHandler {
  return (req, res, next) => {
    const trimmed = apiKey?.trim();
    if (!trimmed) {
      next();
      return;
    }
    const bearer = req.header("authorization")?.replace(/^Bearer\s+/i, "")?.trim();
    const headerKey = req.header("x-api-key")?.trim();
    const key = bearer || headerKey || "";
    if (key !== trimmed) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isRunLike(v: unknown): v is Run {
  if (v == null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.runId === "string" && typeof r.status === "string" && Array.isArray(r.history);
}

function isJobWaitTimeout(msg: string): boolean {
  return msg.includes("timed out before finishing");
}

function parseWait(req: Request): boolean {
  return (
    req.query.wait === "1" ||
    req.query.wait === "true" ||
    (typeof (req.body as { wait?: unknown })?.wait === "boolean" &&
      (req.body as { wait: boolean }).wait === true)
  );
}

function statusUrl(req: Request, jobId: string): string {
  const base = req.baseUrl.endsWith("/") ? req.baseUrl.slice(0, -1) : req.baseUrl;
  return `${base}/jobs/${jobId}`;
}

/**
 * Express **`Router`** with **plan-rest**-shaped routes (see repo **`docs/plan-rest.md`**).
 * Mount with **`app.use(createPlanRestRouter({ … }))`** (or under a prefix like **`/api`**).
 *
 * **Execution:** provide **`runtime`** for **inline** runs, **`dispatch`** for **BullMQ** enqueue (like **`dynamic-runtime-rest`**), or **both** (dispatch wins for **`POST` run/resume**).
 *
 * **Tenancy:** pass **`projectId`** for a single fixed tenant, or omit it and resolve per request
 * (**`defaultPlanRestResolveProjectId`**: header **`X-Project-Id`**, **`?projectId=`**, then **`body.projectId`** on POST).
 */
export function createPlanRestRouter(options: PlanRestPluginOptions): Router {
  const {
    runtime,
    dispatch,
    projectId: fixedProjectId,
    allowedProjectIds,
    resolveProjectId = defaultPlanRestResolveProjectId,
    agentIds,
    runStore,
    apiKey,
    swagger: swaggerOption,
  } = options;

  if (!dispatch && !runtime) {
    throw new Error(
      "createPlanRestRouter: provide `runtime` (inline Agent.run) and/or `dispatch` ({ engine, … }) for BullMQ — at least one is required.",
    );
  }

  const jobWaitMs = dispatch?.jobWaitTimeoutMs ?? 120_000;
  const allowlist = agentIds !== undefined ? new Set(agentIds) : null;
  const allowAllProjects = allowedProjectIds?.includes("*") === true;
  const allowedProjectsExclusive =
    !allowAllProjects &&
    allowedProjectIds !== undefined &&
    allowedProjectIds.length > 0
      ? new Set(allowedProjectIds.filter((id) => id !== "*"))
      : null;

  function isRunnableAgent(projectId: string, agentId: string): boolean {
    if (allowlist !== null) return allowlist.has(agentId);
    return getAgentDefinition(projectId, agentId) !== undefined;
  }

  const resolveEffectiveProjectId: RequestHandler = (req, res, next) => {
    let pid: string | undefined;
    if (fixedProjectId !== undefined && fixedProjectId.trim() !== "") {
      pid = fixedProjectId.trim();
    } else {
      pid = resolveProjectId(req)?.trim();
      if (!pid) {
        res.status(400).json({
          error:
            "projectId required: set option projectId, or send header X-Project-Id, query ?projectId=, or JSON body.projectId (POST)",
        });
        return;
      }
    }
    if (
      allowedProjectsExclusive !== null &&
      !allowedProjectsExclusive.has(pid)
    ) {
      res.status(403).json({ error: "unknown project" });
      return;
    }
    (res.locals as Record<string, string>)[localsKey] = pid;
    next();
  };

  const r = express.Router();
  r.use(express.json({ limit: "512kb" }));

  const swaggerPaths = normalizePlanRestSwaggerPaths(swaggerOption);
  if (swaggerPaths) {
    const multiProjectOpenApi = !(fixedProjectId !== undefined && fixedProjectId.trim() !== "");
    const swaggerInfo = planRestSwaggerInfo(swaggerOption);
    const spec = buildPlanRestOpenApiSpec({
      hasDispatch: !!dispatch,
      hasRunStore: !!runStore,
      multiProject: multiProjectOpenApi,
      hasApiKey: !!(apiKey?.trim()),
      title: swaggerInfo?.title,
      version: swaggerInfo?.version,
      description: swaggerInfo?.description,
    });
    const html = planRestSwaggerUiHtml(swaggerPaths.openApiPath, swaggerPaths.uiPath);
    r.get(`/${swaggerPaths.openApiPath}`, (_req, res) => {
      res.type("application/json; charset=utf-8").json(spec);
    });
    r.get(`/${swaggerPaths.uiPath}`, (_req, res) => {
      res.type("text/html; charset=utf-8").send(html);
    });
  }

  r.use(optionalApiKeyAuth(apiKey));
  r.use(resolveEffectiveProjectId);

  r.get("/agents", (_req, res) => {
    const projectId = getPlanRestProjectId(res);
    const ids =
      allowlist !== null ? [...allowlist].sort() : listAgentIdsForProject(projectId);
    res.json({
      projectId,
      agents: ids.map((id) => ({ id })),
    });
  });

  r.post("/agents/:agentId/run", async (req, res) => {
    const projectId = getPlanRestProjectId(res);
    const { agentId } = req.params;
    if (!isRunnableAgent(projectId, agentId)) {
      res.status(404).json({ error: "unknown agent" });
      return;
    }

    const body = req.body as { message?: unknown; sessionId?: unknown };
    if (typeof body.message !== "string" || !body.message.trim()) {
      res.status(400).json({ error: "message (string) required" });
      return;
    }

    const sessionId =
      typeof body.sessionId === "string" && body.sessionId.trim()
        ? body.sessionId.trim()
        : randomUUID();

    if (dispatch) {
      const wait = parseWait(req);
      let jobId = "";
      try {
        const job = await dispatch.engine.addRun({
          projectId,
          agentId,
          sessionId,
          userInput: body.message.trim(),
        });
        jobId = job.id ?? "";
        if (!jobId) {
          res.status(500).json({ sessionId, error: "enqueue failed (missing job id)" });
          return;
        }

        if (!wait) {
          const url = statusUrl(req, jobId);
          res.status(202).json({
            jobId,
            sessionId,
            statusUrl: url,
            pollUrl: url,
          });
          return;
        }

        if (!dispatch.queueEvents) {
          res.status(501).json({
            error: "dispatch.queueEvents is required when using wait=1 or body.wait true",
          });
          return;
        }

        let finishedValue: unknown;
        try {
          finishedValue = await job.waitUntilFinished(dispatch.queueEvents, jobWaitMs);
        } catch (waitErr) {
          const msg = errorMessage(waitErr);
          if (isJobWaitTimeout(msg)) {
            res.status(504).json({ jobId, sessionId, error: msg });
            return;
          }
          res.status(502).json({ jobId, sessionId, error: msg });
          return;
        }

        if (isRunLike(finishedValue)) {
          const s = summarizeEngineRun(finishedValue);
          res.json({
            jobId,
            sessionId,
            runId: s.runId,
            status: s.status,
            ...(s.reply !== undefined ? { reply: s.reply } : {}),
          });
          return;
        }

        const fromJob = job.returnvalue;
        if (isRunLike(fromJob)) {
          const s = summarizeEngineRun(fromJob);
          res.json({
            jobId,
            sessionId,
            runId: s.runId,
            status: s.status,
            ...(s.reply !== undefined ? { reply: s.reply } : {}),
          });
          return;
        }

        res.status(500).json({
          jobId,
          sessionId,
          error: "job finished but return value is missing or not a Run",
        });
      } catch (e) {
        res.status(503).json({ sessionId, error: errorMessage(e) });
      }
      return;
    }

    if (!runtime) {
      res.status(501).json({ error: "runtime is required for inline run when dispatch is not set" });
      return;
    }

    try {
      const session = new Session({ id: sessionId, projectId });
      const agent = await Agent.load(agentId, runtime, { session });
      const run = await agent.run(body.message.trim());

      const payload: Record<string, unknown> = {
        sessionId,
        runId: run.runId,
        status: run.status,
      };
      const reply = resultText(run);
      if (reply !== undefined) payload.reply = reply;
      if (run.status === "waiting") {
        const hint: Record<string, unknown> = {
          method: "POST",
          path: `/agents/${agentId}/resume`,
          body: {
            runId: run.runId,
            sessionId,
            resumeInput: { type: "text", content: "<user follow-up>" },
          },
        };
        if (fixedProjectId === undefined || fixedProjectId.trim() === "") {
          hint.headers = { "X-Project-Id": projectId };
          (hint.body as Record<string, unknown>).projectId = projectId;
        }
        payload.resumeHint = hint;
      }

      res.json(payload);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  r.post("/agents/:agentId/resume", async (req, res) => {
    if (!dispatch && !runStore) {
      res.status(501).json({ error: "runStore is required for inline resume" });
      return;
    }

    const projectId = getPlanRestProjectId(res);
    const { agentId } = req.params;
    if (!isRunnableAgent(projectId, agentId)) {
      res.status(404).json({ error: "unknown agent" });
      return;
    }

    const body = req.body as {
      runId?: unknown;
      sessionId?: unknown;
      resumeInput?: unknown;
    };
    if (typeof body.runId !== "string" || !body.runId.trim()) {
      res.status(400).json({ error: "runId (string) required" });
      return;
    }
    if (typeof body.sessionId !== "string" || !body.sessionId.trim()) {
      res.status(400).json({ error: "sessionId (string) required" });
      return;
    }
    const ri = body.resumeInput;
    if (
      ri == null ||
      typeof ri !== "object" ||
      typeof (ri as { type?: unknown }).type !== "string" ||
      typeof (ri as { content?: unknown }).content !== "string"
    ) {
      res.status(400).json({
        error: "resumeInput required: { type: string, content: string }",
      });
      return;
    }
    const resumeInput = ri as { type: string; content: string };

    if (dispatch) {
      const wait = parseWait(req);
      let jobId = "";
      try {
        const job = await dispatch.engine.addResume({
          projectId,
          agentId,
          sessionId: body.sessionId.trim(),
          runId: body.runId.trim(),
          resumeInput,
        });
        jobId = job.id ?? "";
        if (!jobId) {
          res.status(500).json({ error: "enqueue failed (missing job id)" });
          return;
        }

        if (!wait) {
          const url = statusUrl(req, jobId);
          res.status(202).json({
            jobId,
            sessionId: body.sessionId.trim(),
            runId: body.runId.trim(),
            statusUrl: url,
            pollUrl: url,
          });
          return;
        }

        if (!dispatch.queueEvents) {
          res.status(501).json({
            error: "dispatch.queueEvents is required when using wait=1 or body.wait true",
          });
          return;
        }

        let finishedValue: unknown;
        try {
          finishedValue = await job.waitUntilFinished(dispatch.queueEvents, jobWaitMs);
        } catch (waitErr) {
          const msg = errorMessage(waitErr);
          if (isJobWaitTimeout(msg)) {
            res.status(504).json({ jobId, sessionId: body.sessionId.trim(), error: msg });
            return;
          }
          res.status(502).json({ jobId, sessionId: body.sessionId.trim(), error: msg });
          return;
        }

        if (isRunLike(finishedValue)) {
          const s = summarizeEngineRun(finishedValue);
          res.json({
            jobId,
            sessionId: body.sessionId.trim(),
            runId: s.runId,
            status: s.status,
            ...(s.reply !== undefined ? { reply: s.reply } : {}),
          });
          return;
        }

        const fromJob = job.returnvalue;
        if (isRunLike(fromJob)) {
          const s = summarizeEngineRun(fromJob);
          res.json({
            jobId,
            sessionId: body.sessionId.trim(),
            runId: s.runId,
            status: s.status,
            ...(s.reply !== undefined ? { reply: s.reply } : {}),
          });
          return;
        }

        res.status(500).json({
          jobId,
          error: "job finished but return value is missing or not a Run",
        });
      } catch (e) {
        res.status(503).json({ error: errorMessage(e) });
      }
      return;
    }

    if (!runtime) {
      res.status(501).json({ error: "runtime is required for inline resume when dispatch is not set" });
      return;
    }

    try {
      const session = new Session({
        id: body.sessionId.trim(),
        projectId,
      });
      const agent = await Agent.load(agentId, runtime, { session });
      const run = await agent.resume(body.runId.trim(), resumeInput);

      const payload: Record<string, unknown> = {
        sessionId: body.sessionId.trim(),
        runId: run.runId,
        status: run.status,
      };
      const reply = resultText(run);
      if (reply !== undefined) payload.reply = reply;

      res.json(payload);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  r.get("/runs/:runId", async (req, res) => {
    if (!runStore) {
      res.status(501).json({ error: "runStore is required" });
      return;
    }

    const { runId } = req.params;
    const q = req.query.sessionId;
    const sessionId = typeof q === "string" && q.trim() ? q.trim() : "";
    if (!sessionId) {
      res.status(400).json({ error: "Query ?sessionId= is required" });
      return;
    }

    try {
      const run = await runStore.load(runId);
      if (!run) {
        res.status(404).json({ error: "run not found" });
        return;
      }
      if (run.sessionId != null && run.sessionId !== sessionId) {
        res.status(403).json({ error: "sessionId does not match this run" });
        return;
      }

      const userInput =
        typeof run.state.userInput === "string" ? run.state.userInput : undefined;

      res.json({
        runId: run.runId,
        agentId: run.agentId,
        sessionId: run.sessionId,
        status: run.status,
        ...(userInput !== undefined ? { userInput } : {}),
        reply: resultText(run),
        iteration: run.state.iteration,
        historyStepCount: run.history.length,
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  if (dispatch) {
    r.get("/jobs/:jobId", async (req, res) => {
      try {
        const job = await dispatch.engine.queue.getJob(req.params.jobId);
        if (!job) {
          res.status(404).json({ error: "job not found" });
          return;
        }
        const state = await job.getState();
        const failedReason = job.failedReason;
        const returnvalue = job.returnvalue as Run | undefined;
        res.json({
          id: job.id,
          state,
          failedReason: failedReason || undefined,
          run:
            returnvalue && state === "completed" && isRunLike(returnvalue)
              ? summarizeEngineRun(returnvalue)
              : undefined,
        });
      } catch (e) {
        res.status(500).json({ error: errorMessage(e) });
      }
    });
  }

  return r;
}
