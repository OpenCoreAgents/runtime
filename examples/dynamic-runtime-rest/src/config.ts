import { DEFAULT_ENGINE_QUEUE_NAME } from "@opencoreagents/adapters-bullmq";

export const PORT = Number(process.env.PORT) || 3010;
/** All /v1 routes use this tenant id unless you add per-request resolution. */
export const PROJECT_ID = process.env.PROJECT_ID?.trim() || "dynamic-demo";
/** API createEngineQueue + worker createEngineWorker must use the same name. */
export const ENGINE_QUEUE_NAME = process.env.ENGINE_QUEUE_NAME?.trim() || DEFAULT_ENGINE_QUEUE_NAME;
/** Redis HASH key prefix: `{prefix}:{projectId}:agents|skills|httpTools`. */
export const DEF_KEY_PREFIX = process.env.DEF_KEY_PREFIX?.replace(/:+$/, "") || "def";

/** When `POST /v1/run` uses `?wait=1`, max ms for BullMQ `waitUntilFinished`. `RUN_WAIT_TIMEOUT_MS` or legacy `RUN_SYNC_TIMEOUT_MS`. */
export const RUN_WAIT_TIMEOUT_MS =
  Number(process.env.RUN_WAIT_TIMEOUT_MS ?? process.env.RUN_SYNC_TIMEOUT_MS) || 60_000;
