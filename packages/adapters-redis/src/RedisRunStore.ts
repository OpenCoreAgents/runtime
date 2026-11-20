import type {
  Run,
  RunStatus,
  RunStore,
  RunStoreListByAgentAndSessionOptions,
  RunStoreListResult,
} from "@opencoreagents/core";
import type Redis from "ioredis";

type ClaimPendingAction = NonNullable<RunStore["claimPendingAction"]>;

// Compare the original JSON without a Lua decode/encode round trip. Prepared
// inputs must preserve their JSON shape, including empty arrays and objects.
const claimRunScript = `
  if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
  redis.call("SET", KEYS[1], ARGV[2])
  return 1
`;

function isolationScope(projectId: string, tenantId?: string): string {
  return tenantId && tenantId.trim()
    ? `tenant:${tenantId.trim()}:project:${projectId}`
    : `project:${projectId}`;
}

function sessionIndexKey(
  projectId: string,
  agentId: string,
  sessionId: string,
  tenantId?: string,
): string {
  return `run:agent-session:${isolationScope(projectId, tenantId)}:${agentId}:${sessionId}`;
}

function matchesIsolationScope(run: Run, projectId: string, tenantId?: string): boolean {
  if (run.projectId !== projectId) return false;
  if (tenantId !== undefined) return run.tenantId === tenantId;
  return run.tenantId === undefined;
}

function runRecencyScore(run: Run): number {
  const lastTs = run.history[run.history.length - 1]?.meta.ts;
  const parsed = lastTs ? Date.parse(lastTs) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Persists {@link Run} JSON in Redis — same keys as {@link UpstashRunStore}
 * (`run:data:{runId}`, `run:agent:{agentId}` SET).
 */
export class RedisRunStore implements RunStore {
  constructor(private readonly redis: Redis) {}

  async save(run: Run): Promise<void> {
    const key = `run:data:${run.runId}`;
    const tx = this.redis.multi().set(key, JSON.stringify(run)).sadd(`run:agent:${run.agentId}`, run.runId);
    if (run.sessionId && run.projectId) {
      tx.zadd(
        sessionIndexKey(run.projectId, run.agentId, run.sessionId, run.tenantId),
        runRecencyScore(run),
        run.runId,
      );
    }
    await tx.exec();
  }

  async saveIfStatus(run: Run, expectedStatus: RunStatus): Promise<boolean> {
    const key = `run:data:${run.runId}`;
    const agentKey = `run:agent:${run.agentId}`;
    await this.redis.watch(key);
    const raw = await this.redis.get(key);
    if (raw == null || raw === "") {
      await this.redis.unwatch();
      return false;
    }
    let existing: Run;
    try {
      existing = JSON.parse(raw) as Run;
    } catch {
      await this.redis.unwatch();
      return false;
    }
    if (existing.status !== expectedStatus) {
      await this.redis.unwatch();
      return false;
    }
    const tx = this.redis.multi().set(key, JSON.stringify(run)).sadd(agentKey, run.runId);
    if (run.sessionId && run.projectId) {
      tx.zadd(
        sessionIndexKey(run.projectId, run.agentId, run.sessionId, run.tenantId),
        runRecencyScore(run),
        run.runId,
      );
    }
    const execResult = await tx.exec();
    return execResult != null;
  }

  async load(runId: string): Promise<Run | null> {
    const raw = await this.redis.get(`run:data:${runId}`);
    if (raw == null || raw === "") return null;
    return JSON.parse(raw) as Run;
  }

  async claimPendingAction(
    input: Parameters<ClaimPendingAction>[0],
  ): ReturnType<ClaimPendingAction> {
    const key = `run:data:${input.runId}`;
    for (;;) {
      const raw = await this.redis.get(key);
      if (!raw) return { ok: false, reason: "not_found" };

      const run = JSON.parse(raw) as Run;
      if (run.status !== input.expectedStatus) return { ok: false, reason: "not_waiting" };

      const pending = run.state.pending;
      if (pending?.kind !== "tool_approval" || pending.actionId !== input.actionId) {
        return { ok: false, reason: "action_mismatch" };
      }
      if (pending.claimed) return { ok: false, reason: "already_claimed" };

      run.status = "running";
      pending.claimed = true;
      pending.claimedAt = new Date().toISOString();
      pending.claimant = "redis-store";
      pending.attempts = (pending.attempts ?? 0) + 1;
      // The claim changes neither the run's scope nor its history/index entries.
      const claimed = await this.redis.eval(claimRunScript, 1, key, raw, JSON.stringify(run));
      if (claimed === 1) {
        return { ok: true, run, idempotencyKey: `${input.runId}_${input.actionId}` };
      }
    }
  }

  async delete(runId: string): Promise<void> {
    const existing = await this.load(runId);
    const tx = this.redis.multi().del(`run:data:${runId}`);
    if (existing) {
      tx.srem(`run:agent:${existing.agentId}`, runId);
      if (existing.sessionId && existing.projectId) {
        tx.zrem(
          sessionIndexKey(
            existing.projectId,
            existing.agentId,
            existing.sessionId,
            existing.tenantId,
          ),
          runId,
        );
      }
    }
    await tx.exec();
  }

  async listByAgent(agentId: string, status?: RunStatus): Promise<Run[]> {
    const ids = await this.redis.smembers(`run:agent:${agentId}`);
    const out: Run[] = [];
    for (const id of ids) {
      const run = await this.load(id);
      if (!run) continue;
      if (status !== undefined && run.status !== status) continue;
      out.push(run);
    }
    return out;
  }

  async listByAgentAndSession(
    projectId: string,
    agentId: string,
    sessionId: string,
    opts?: RunStoreListByAgentAndSessionOptions,
  ): Promise<RunStoreListResult> {
    const order = opts?.order ?? "desc";
    const limit = Math.max(1, opts?.limit ?? 50);
    const offset = parseCursor(opts?.cursor);
    const stop = offset + limit;
    const key = sessionIndexKey(projectId, agentId, sessionId, opts?.tenantId);
    const ids =
      order === "asc"
        ? await this.redis.zrange(key, offset, stop)
        : await this.redis.zrevrange(key, offset, stop);
    const runs: Run[] = [];
    for (const id of ids) {
      const run = await this.load(id);
      if (!run) continue;
      if (!matchesIsolationScope(run, projectId, opts?.tenantId)) continue;
      if (run.sessionId !== sessionId) continue;
      if (opts?.status !== undefined && run.status !== opts.status) continue;
      runs.push(run);
    }
    return {
      runs: runs.slice(0, limit),
      nextCursor: ids.length > limit ? String(offset + limit) : undefined,
    };
  }
}
