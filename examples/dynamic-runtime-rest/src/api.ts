/**
 * Control plane: writes definitions to Redis (`RedisDynamicDefinitionsStore`), enqueues engine jobs.
 * Does not run `Agent.run` inline — workers use `AgentRuntime` with `dynamicDefinitionsStore` so `dispatch` hydrates per job.
 */
import { createEngineQueue } from "@opencoreagents/adapters-bullmq";
import { RedisDynamicDefinitionsStore } from "@opencoreagents/adapters-redis";
import { QueueEvents } from "bullmq";
import express from "express";
import { DEF_KEY_PREFIX, ENGINE_QUEUE_NAME, PORT, PROJECT_ID, RUN_WAIT_TIMEOUT_MS } from "./config.js";
import { createRedis } from "./redisClient.js";
import { createV1Router } from "./v1Router.js";

async function main(): Promise<void> {
  const redis = createRedis();
  const queueRedis = redis.duplicate();
  const eventsRedis = redis.duplicate();

  // Definition HASHes on `redis` (same connection as CRUD in v1Router); facade exposes `store.methods` + `store.Agent` / `Skill` / `HttpTool`.
  const store = new RedisDynamicDefinitionsStore(redis, { keyPrefix: DEF_KEY_PREFIX });
  // BullMQ producer: enqueue `run` / `resume` jobs on a dedicated client (do not share with store or events).
  const engine = createEngineQueue(ENGINE_QUEUE_NAME, queueRedis);
  // Pub/sub for job completed/failed; required for `job.waitUntilFinished` when `POST /run?wait=1`.
  const queueEvents = new QueueEvents(ENGINE_QUEUE_NAME, { connection: eventsRedis });
  // Ensure listeners are active before any `waitUntilFinished` (avoids races if a job finishes immediately).
  await queueEvents.waitUntilReady();

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "dynamic-runtime-rest-api",
      projectId: PROJECT_ID,
      queue: ENGINE_QUEUE_NAME,
    });
  });

  app.use(
    "/v1",
    createV1Router({
      store,
      engine,
      queueEvents,
      projectId: PROJECT_ID,
      runWaitTimeoutMs: RUN_WAIT_TIMEOUT_MS,
    }),
  );

  const server = app.listen(PORT, () => {
    console.log(`dynamic-runtime-rest API http://localhost:${PORT}`);
    console.log(
      `projectId=${PROJECT_ID} queue=${ENGINE_QUEUE_NAME} — start worker: pnpm start:worker`,
    );
  });

  const close = async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await queueEvents.close();
    await engine.queue.close();
    await eventsRedis.quit();
    await queueRedis.quit();
    await redis.quit();
  };
  process.on("SIGINT", () => void close().then(() => process.exit(0)));
  process.on("SIGTERM", () => void close().then(() => process.exit(0)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
