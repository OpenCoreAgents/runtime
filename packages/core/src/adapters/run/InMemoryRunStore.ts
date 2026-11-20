import type { Run, RunStatus } from "../../protocol/types.js";
import type { RunStore, RunStoreListByAgentAndSessionOptions } from "./RunStore.js";

function runRecencyScore(run: Run): number {
  const lastTs = run.history[run.history.length - 1]?.meta.ts;
  const parsed = lastTs ? Date.parse(lastTs) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** In-process run store — suitable for tests and single-process deployments only. */
export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, Run>();

  async save(run: Run): Promise<void> {
    this.runs.set(run.runId, structuredClone(run));
  }

  async saveIfStatus(run: Run, expectedStatus: RunStatus): Promise<boolean> {
    const cur = this.runs.get(run.runId);
    if (!cur || cur.status !== expectedStatus) return false;
    this.runs.set(run.runId, structuredClone(run));
    return true;
  }

  async load(runId: string): Promise<Run | null> {
    const r = this.runs.get(runId);
    return r ? structuredClone(r) : null;
  }

  async delete(runId: string): Promise<void> {
    this.runs.delete(runId);
  }

  async listByAgent(agentId: string, status?: RunStatus): Promise<Run[]> {
    const out: Run[] = [];
    for (const r of this.runs.values()) {
      if (r.agentId !== agentId) continue;
      if (status !== undefined && r.status !== status) continue;
      out.push(structuredClone(r));
    }
    return out;
  }

  async listByAgentAndSession(
    projectId: string,
    agentId: string,
    sessionId: string,
    opts?: RunStoreListByAgentAndSessionOptions,
  ): Promise<{ runs: Run[]; nextCursor?: string }> {
    const order = opts?.order ?? "desc";
    const limit = Math.max(1, opts?.limit ?? 50);
    const offset = parseCursor(opts?.cursor);
    const rows: Run[] = [];
    for (const run of this.runs.values()) {
      if (run.projectId !== projectId) continue;
      if (opts?.tenantId !== undefined) {
        if (run.tenantId !== opts.tenantId) continue;
      } else if (run.tenantId !== undefined) {
        continue;
      }
      if (run.agentId !== agentId) continue;
      if (run.sessionId !== sessionId) continue;
      if (opts?.status !== undefined && run.status !== opts.status) continue;
      rows.push(structuredClone(run));
    }
    rows.sort((a, b) => {
      const diff = runRecencyScore(a) - runRecencyScore(b);
      return order === "asc" ? diff : -diff;
    });
    const page = rows.slice(offset, offset + limit + 1);
    const runs = page.slice(0, limit);
    const nextCursor = page.length > limit ? String(offset + limit) : undefined;
    return { runs, nextCursor };
  }

  /**
   * Atomically claim a pending tool-action approval. Two concurrent calls
   * for the same runId+actionId will have one succeed and one fail with
   * `already_claimed`.
   */
  async claimPendingAction(input: {
    runId: string;
    actionId: string;
    expectedStatus: "waiting";
  }): Promise<
    | { ok: true; run: Run; idempotencyKey: string }
    | { ok: false; reason: "not_found" | "not_waiting" | "action_mismatch" | "already_claimed" }
  > {
    const cur = this.runs.get(input.runId);
    if (!cur) {
      return { ok: false, reason: "not_found" };
    }
    if (cur.status !== "waiting") {
      return { ok: false, reason: "not_waiting" };
    }
    const pending = cur.state.pending;
    if (
      !pending ||
      pending.kind !== "tool_approval" ||
      pending.actionId !== input.actionId
    ) {
      return { ok: false, reason: "action_mismatch" };
    }
    if (pending.claimed) {
      return { ok: false, reason: "already_claimed" };
    }

    const idempotencyKey = `${input.runId}_${input.actionId}`;

    // Atomic update: mark as claimed
    const claimed: Run = structuredClone(cur);
    claimed.status = "running";
    if (claimed.state.pending && claimed.state.pending.kind === "tool_approval") {
      claimed.state.pending.claimed = true;
      claimed.state.pending.claimedAt = new Date().toISOString();
      claimed.state.pending.claimant = "in-memory-store";
      claimed.state.pending.attempts = (pending.attempts ?? 0) + 1;
    }
    // Save in a single set operation (synchronous in-memory)
    this.runs.set(input.runId, claimed);

    return {
      ok: true,
      run: structuredClone(claimed),
      idempotencyKey,
    };
  }
}
