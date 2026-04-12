/**
 * Express `/v1` routes: definition CRUD, job polling, enqueue run.
 */
import type { HttpToolConfig } from "@opencoreagents/adapters-http-tool";
import type { EngineQueue } from "@opencoreagents/adapters-bullmq";
import type { RedisDynamicDefinitionsStore } from "@opencoreagents/adapters-redis";
import type { AgentDefinitionPersisted, SkillDefinitionPersisted } from "@opencoreagents/core";
import type { Run } from "@opencoreagents/core";
import type { QueueEvents } from "bullmq";
import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { summarizeRun } from "./runSummary.js";

export interface V1RouterDeps {
  store: RedisDynamicDefinitionsStore;
  engine: EngineQueue;
  queueEvents: QueueEvents;
  projectId: string;
  runWaitTimeoutMs: number;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isRunLike(v: unknown): v is Run {
  if (v == null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.runId === "string" && typeof r.status === "string" && Array.isArray(r.history);
}

/** BullMQ `waitUntilFinished` rejects with this substring when `ttl` elapses. */
function isJobWaitTimeout(msg: string): boolean {
  return msg.includes("timed out before finishing");
}

function idMismatchResponse(
  res: Response,
  body: Record<string, unknown>,
  paramId: string,
  paramLabel: string,
): boolean {
  if (body.id != null && body.id !== paramId) {
    res.status(400).json({ error: `body.id must match :${paramLabel}` });
    return true;
  }
  return false;
}

async function withClientError(res: Response, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    res.status(400).json({ error: errorMessage(e) });
  }
}

function parsePostRunBody(req: Request): {
  agentId: string;
  /** Empty when the client omitted `sessionId` — caller should assign e.g. `randomUUID()`. */
  sessionIdInput: string;
  message: string;
  wait: boolean;
} {
  const agentId = typeof req.body?.agentId === "string" ? req.body.agentId : "";
  const sessionIdInput =
    typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
  const message = typeof req.body?.message === "string" ? req.body.message : "";
  // Query `?wait=1` | `?wait=true` or JSON `"wait": true` (boolean only — not `await`, reserved).
  const wait =
    req.query.wait === "1" ||
    req.query.wait === "true" ||
    (typeof req.body?.wait === "boolean" && req.body.wait);
  return { agentId, sessionIdInput, message, wait };
}

export function createV1Router(deps: V1RouterDeps): Router {
  const { store, engine, queueEvents, projectId, runWaitTimeoutMs } = deps;
  const r = Router();

  r.get("/definitions", async (_req, res) => {
    try {
      const snap = await store.methods.getSnapshot(projectId);
      res.json(snap);
    } catch (e) {
      res.status(500).json({ error: errorMessage(e) });
    }
  });

  r.put("/http-tools/:toolId", async (req, res) => {
    await withClientError(res, async () => {
      const body = req.body as Record<string, unknown>;
      if (idMismatchResponse(res, body, req.params.toolId, "toolId")) return;
      const secrets =
        typeof body._secrets === "object" && body._secrets !== null
          ? (body._secrets as Record<string, string>)
          : {};
      const { _secrets: _s, ...config } = body;
      const full = { ...config, id: req.params.toolId, projectId } as HttpToolConfig;
      // _secrets only affect this API process; worker uses HTTP_TOOL_SECRETS_JSON.
      await store.HttpTool.define(full, { secrets });
      res.json({ ok: true, id: req.params.toolId });
    });
  });

  r.put("/skills/:skillId", async (req, res) => {
    await withClientError(res, async () => {
      const body = req.body as Record<string, unknown>;
      if (idMismatchResponse(res, body, req.params.skillId, "skillId")) return;
      const skill = {
        ...body,
        id: req.params.skillId,
        projectId,
        tools: body.tools ?? [],
      } as SkillDefinitionPersisted;
      await store.Skill.define(skill);
      res.json({ ok: true, id: req.params.skillId });
    });
  });

  r.put("/agents/:agentId", async (req, res) => {
    await withClientError(res, async () => {
      const body = req.body as Record<string, unknown>;
      if (idMismatchResponse(res, body, req.params.agentId, "agentId")) return;
      const agent = {
        ...body,
        id: req.params.agentId,
        projectId,
      } as AgentDefinitionPersisted;
      await store.Agent.define(agent);
      res.json({ ok: true, id: req.params.agentId });
    });
  });

  r.get("/jobs/:jobId", async (req, res) => {
    try {
      const job = await engine.queue.getJob(req.params.jobId);
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
            ? summarizeRun(returnvalue)
            : undefined,
      });
    } catch (e) {
      res.status(500).json({ error: errorMessage(e) });
    }
  });

  // Default: 202 + poll GET /jobs. `wait=1` blocks until BullMQ waitUntilFinished (see RUN_WAIT_TIMEOUT_MS).
  r.post("/run", async (req, res) => {
    const { agentId, sessionIdInput, message, wait } = parsePostRunBody(req);

    if (!agentId || !message) {
      res.status(400).json({ error: "agentId and message are required" });
      return;
    }

    const sessionId = sessionIdInput || randomUUID();

    let jobId = "";
    try {
      const job = await engine.addRun({
        projectId,
        agentId,
        sessionId,
        userInput: message,
      });

      jobId = job.id ?? "";
      if (!jobId) {
        res.status(500).json({ sessionId, error: "enqueue failed (missing job id)" });
        return;
      }

      if (!wait) {
        res.status(202).json({
          jobId,
          sessionId,
          statusUrl: `/v1/jobs/${jobId}`,
        });
        return;
      }

      let finishedValue: unknown;
      try {
        finishedValue = await job.waitUntilFinished(queueEvents, runWaitTimeoutMs);
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
        res.json({ jobId, sessionId, ...summarizeRun(finishedValue) });
        return;
      }

      const fromJob = job.returnvalue;
      if (isRunLike(fromJob)) {
        res.json({ jobId, sessionId, ...summarizeRun(fromJob) });
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
  });

  return r;
}
