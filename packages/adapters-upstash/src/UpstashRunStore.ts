import type {
  Run,
  RunStatus,
  RunStore,
  RunStoreListByAgentAndSessionOptions,
  RunStoreListResult,
} from "@opencoreagents/core";

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
 * Persists {@link Run} JSON in Upstash Redis (same REST endpoint as {@link UpstashRedisMemoryAdapter}).
 *
 * Keys:
 * - `run:data:{runId}` — JSON-serialized `Run`
 * - `run:agent:{agentId}` — SET of `runId` values for listing
 */
export class UpstashRunStore implements RunStore {
  /** Atomic CAS in one round-trip (REST cannot `WATCH` across requests). */
  private static readonly SAVE_IF_STATUS_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local expected = ARGV[1]
local status = string.match(raw, '"status":"([^"]*)"')
if not status or status ~= expected then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SADD', 'run:agent:' .. ARGV[3], ARGV[4])
if ARGV[5] ~= '' and ARGV[6] ~= '' then
  local scope = 'project:' .. ARGV[6]
  if ARGV[7] ~= '' then
    scope = 'tenant:' .. ARGV[7] .. ':project:' .. ARGV[6]
  end
  redis.call('ZADD', 'run:agent-session:' .. scope .. ':' .. ARGV[3] .. ':' .. ARGV[5], ARGV[8], ARGV[4])
end
return 1
`;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async cmd(args: (string | number)[]): Promise<unknown> {
    const res = await fetch(`${this.url}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      throw new Error(`Upstash Redis ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { result?: unknown };
    return data.result;
  }

  async save(run: Run): Promise<void> {
    const key = `run:data:${run.runId}`;
    await this.cmd(["SET", key, JSON.stringify(run)]);
    await this.cmd(["SADD", `run:agent:${run.agentId}`, run.runId]);
    if (run.sessionId && run.projectId) {
      await this.cmd([
        "ZADD",
        sessionIndexKey(run.projectId, run.agentId, run.sessionId, run.tenantId),
        runRecencyScore(run),
        run.runId,
      ]);
    }
  }

  async saveIfStatus(run: Run, expectedStatus: RunStatus): Promise<boolean> {
    const key = `run:data:${run.runId}`;
    const n = await this.cmd([
      "EVAL",
      UpstashRunStore.SAVE_IF_STATUS_LUA,
      "1",
      key,
      expectedStatus,
      JSON.stringify(run),
      run.agentId,
      run.runId,
      run.sessionId ?? "",
      run.projectId ?? "",
      run.tenantId ?? "",
      runRecencyScore(run),
    ]);
    return n === 1 || n === true;
  }

  async load(runId: string): Promise<Run | null> {
    const raw = await this.cmd(["GET", `run:data:${runId}`]);
    if (raw == null || raw === "") return null;
    if (typeof raw !== "string") return null;
    return JSON.parse(raw) as Run;
  }

  async delete(runId: string): Promise<void> {
    const existing = await this.load(runId);
    await this.cmd(["DEL", `run:data:${runId}`]);
    if (existing) {
      await this.cmd(["SREM", `run:agent:${existing.agentId}`, runId]);
      if (existing.sessionId && existing.projectId) {
        await this.cmd([
          "ZREM",
          sessionIndexKey(existing.projectId, existing.agentId, existing.sessionId, existing.tenantId),
          runId,
        ]);
      }
    }
  }

  async listByAgent(agentId: string, status?: RunStatus): Promise<Run[]> {
    const raw = await this.cmd(["SMEMBERS", `run:agent:${agentId}`]);
    const ids = Array.isArray(raw)
      ? (raw as string[])
      : typeof raw === "string"
        ? [raw]
        : [];
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
    const cmd = order === "asc" ? "ZRANGE" : "ZREVRANGE";
    const raw = await this.cmd([
      cmd,
      sessionIndexKey(projectId, agentId, sessionId, opts?.tenantId),
      offset,
      stop,
    ]);
    const ids = Array.isArray(raw)
      ? (raw as string[])
      : typeof raw === "string"
        ? [raw]
        : [];
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
