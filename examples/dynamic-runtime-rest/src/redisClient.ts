import Redis from "ioredis";

/**
 * Shared TCP Redis client. BullMQ requires `maxRetriesPerRequest: null` on ioredis.
 * Use `.duplicate()` for Queue / Worker / QueueEvents so connections do not share blocking state.
 */
export function createRedis(): Redis {
  const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}
