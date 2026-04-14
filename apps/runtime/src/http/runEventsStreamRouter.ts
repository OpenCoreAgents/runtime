import type { RunStore } from "@opencoreagents/core";
import type Redis from "ioredis";
import express, { type Request, type Response, type Router } from "express";
import { runEventsRedisChannel } from "../redis/runEventRedis.js";

/**
 * SSE fan-out for Redis run events (`createRedisRunEventHooks` in **`runEventRedis.ts`**). Same session / project
 * checks as plan REST **`GET /runs/:runId`**.
 */
export function createRunEventsStreamRouter(opts: {
  redis: Redis;
  runStore: RunStore;
  projectId: string;
  definitionsKeyPrefix: string;
}): Router {
  const r = express.Router();

  r.get("/runs/:runId/stream", async (req: Request, res: Response) => {
    const runId = String(req.params.runId ?? "").trim();
    const sessionId =
      typeof req.query.sessionId === "string" && req.query.sessionId.trim().length > 0
        ? req.query.sessionId.trim()
        : "";
    if (!runId || !sessionId) {
      res.status(400).json({ error: "runId (path) and sessionId (query) required" });
      return;
    }

    const run = await opts.runStore.load(runId);
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    if (run.sessionId != null && run.sessionId !== sessionId) {
      res.status(403).json({ error: "sessionId does not match this run" });
      return;
    }
    if (run.projectId != null && run.projectId !== opts.projectId) {
      res.status(403).json({ error: "projectId does not match this run" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    if (typeof (res as Response & { flushHeaders?: () => void }).flushHeaders === "function") {
      (res as Response & { flushHeaders: () => void }).flushHeaders();
    }

    const sub = opts.redis.duplicate();
    const ch = runEventsRedisChannel(opts.definitionsKeyPrefix, runId);

    const writeEvent = (rawJson: string) => {
      res.write("event: run\n");
      for (const line of rawJson.split("\n")) {
        res.write(`data: ${line}\n`);
      }
      res.write("\n");
    };

    const ping = setInterval(() => {
      res.write(": ping\n\n");
    }, 20_000);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(ping);
      sub.removeAllListeners("message");
      void sub.unsubscribe(ch).catch(() => {});
      void sub.quit().catch(() => {});
      if (!res.writableEnded) res.end();
    };

    try {
      await sub.subscribe(ch);
    } catch (e) {
      writeEvent(
        JSON.stringify({
          kind: "stream_error",
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      cleanup();
      return;
    }

    sub.on("message", (_c: string, message: string) => {
      writeEvent(message);
    });

    req.on("close", cleanup);
    req.on("aborted", cleanup);
  });

  return r;
}
