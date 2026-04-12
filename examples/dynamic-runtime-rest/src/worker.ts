/**
 * BullMQ worker: `runtime.dispatch` hydrates definitions from Redis when `dynamicDefinitionsStore` is set on the runtime.
 */
import { createEngineWorker } from "@opencoreagents/adapters-bullmq";
import { RedisDynamicDefinitionsStore } from "@opencoreagents/adapters-redis";
import { AgentRuntime, InMemoryMemoryAdapter } from "@opencoreagents/core";
import { DemoLlm } from "./demoLlm.js";
import { DEF_KEY_PREFIX, ENGINE_QUEUE_NAME } from "./config.js";
import { createRedis } from "./redisClient.js";
import { httpToolSecretsFromEnv } from "./workerSecrets.js";

async function main(): Promise<void> {
  const redis = createRedis();
  const workerRedis = redis.duplicate(); // BullMQ worker must not share the same ioredis instance as HGETALL for defs.
  const store = new RedisDynamicDefinitionsStore(redis, { keyPrefix: DEF_KEY_PREFIX });

  // One runtime per process; LLM/memory adapters shared across jobs (swap memory for Redis in real multi-worker setups).
  const runtime = new AgentRuntime({
    llmAdapter: new DemoLlm(),
    memoryAdapter: new InMemoryMemoryAdapter(),
    maxIterations: 10,
    toolTimeoutMs: 15_000,
    dynamicDefinitionsStore: store,
    dynamicDefinitionsSecrets: httpToolSecretsFromEnv,
  });

  const worker = createEngineWorker(ENGINE_QUEUE_NAME, workerRedis, async (job) => {
    return runtime.dispatch(job.data);
  });

  const shutdown = async (signal: string) => {
    console.log(`${signal}, closing worker…`);
    await worker.close();
    await redis.quit();
    await workerRedis.quit();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  console.log(
    `dynamic-runtime-rest worker listening queue=${ENGINE_QUEUE_NAME} redis=${process.env.REDIS_URL ?? "redis://127.0.0.1:6379"} defPrefix=${DEF_KEY_PREFIX}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
