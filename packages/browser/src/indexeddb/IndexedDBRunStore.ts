import type {
  Run,
  RunStatus,
  RunStore,
  RunStoreListByAgentAndSessionOptions,
  RunStoreListResult,
} from "@opencoreagents/core";
import {
  RUN_STORE_NAME,
  openBrowserDatabase,
  requestResult,
  resolveDatabaseName,
  transactionComplete,
  withIndexedDBOperation,
  type IndexedDBAdapterOptions,
} from "./database.js";

interface StoredRun {
  runId: string;
  agentId: string;
  projectId?: string;
  sessionId?: string;
  tenantId?: string;
  status: RunStatus;
  recency: number;
  run: Run;
}

function runRecencyScore(run: Run): number {
  const lastTimestamp = run.history[run.history.length - 1]?.meta.ts;
  const parsed = lastTimestamp ? Date.parse(lastTimestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function storedRun(run: Run): StoredRun {
  return {
    runId: run.runId,
    agentId: run.agentId,
    projectId: run.projectId,
    sessionId: run.sessionId,
    tenantId: run.tenantId,
    status: run.status,
    recency: runRecencyScore(run),
    run: structuredClone(run),
  };
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** Persistent browser run store with transaction-backed compare-and-swap updates. */
export class IndexedDBRunStore implements RunStore {
  private readonly databaseName: string;

  constructor(options: IndexedDBAdapterOptions = {}) {
    this.databaseName = resolveDatabaseName(options);
  }

  async save(run: Run): Promise<void> {
    await withIndexedDBOperation("Saving browser run", async () => {
      const database = await openBrowserDatabase(this.databaseName);
      const transaction = database.transaction(RUN_STORE_NAME, "readwrite");
      transaction.objectStore(RUN_STORE_NAME).put(storedRun(run));
      await transactionComplete(transaction);
    });
  }

  async saveIfStatus(run: Run, expectedStatus: RunStatus): Promise<boolean> {
    return withIndexedDBOperation("Saving browser run conditionally", async () => {
      const database = await openBrowserDatabase(this.databaseName);
      const transaction = database.transaction(RUN_STORE_NAME, "readwrite");
      const store = transaction.objectStore(RUN_STORE_NAME);
      const current = await requestResult(store.get(run.runId)) as StoredRun | undefined;
      if (!current || current.status !== expectedStatus) {
        await transactionComplete(transaction);
        return false;
      }
      store.put(storedRun(run));
      await transactionComplete(transaction);
      return true;
    });
  }

  async load(runId: string): Promise<Run | null> {
    return withIndexedDBOperation("Loading browser run", async () => {
      const database = await openBrowserDatabase(this.databaseName);
      const transaction = database.transaction(RUN_STORE_NAME, "readonly");
      const record = await requestResult(transaction.objectStore(RUN_STORE_NAME).get(runId)) as
        | StoredRun
        | undefined;
      await transactionComplete(transaction);
      return record ? structuredClone(record.run) : null;
    });
  }

  async delete(runId: string): Promise<void> {
    await withIndexedDBOperation("Deleting browser run", async () => {
      const database = await openBrowserDatabase(this.databaseName);
      const transaction = database.transaction(RUN_STORE_NAME, "readwrite");
      transaction.objectStore(RUN_STORE_NAME).delete(runId);
      await transactionComplete(transaction);
    });
  }

  async listByAgent(agentId: string, status?: RunStatus): Promise<Run[]> {
    return withIndexedDBOperation("Listing browser runs by agent", async () => {
      const database = await openBrowserDatabase(this.databaseName);
      const transaction = database.transaction(RUN_STORE_NAME, "readonly");
      const records = await requestResult(
        transaction.objectStore(RUN_STORE_NAME).index("agentId").getAll(agentId),
      ) as StoredRun[];
      await transactionComplete(transaction);
      return records
        .filter((record) => status === undefined || record.status === status)
        .map((record) => structuredClone(record.run));
    });
  }

  async listByAgentAndSession(
    projectId: string,
    agentId: string,
    sessionId: string,
    options?: RunStoreListByAgentAndSessionOptions,
  ): Promise<RunStoreListResult> {
    return withIndexedDBOperation("Listing browser runs by session", async () => {
      const database = await openBrowserDatabase(this.databaseName);
      const transaction = database.transaction(RUN_STORE_NAME, "readonly");
      const index = transaction.objectStore(RUN_STORE_NAME).index("projectAgentSession");
      const records = await requestResult(
        index.getAll(IDBKeyRange.only([projectId, agentId, sessionId])),
      ) as StoredRun[];
      await transactionComplete(transaction);

      const order = options?.order ?? "desc";
      const limit = Math.max(1, options?.limit ?? 50);
      const offset = parseCursor(options?.cursor);
      const filtered = records.filter((record) => {
        if (options?.tenantId !== undefined) {
          if (record.tenantId !== options.tenantId) return false;
        } else if (record.tenantId !== undefined) {
          return false;
        }
        return options?.status === undefined || record.status === options.status;
      });
      filtered.sort((a, b) => order === "asc" ? a.recency - b.recency : b.recency - a.recency);
      const page = filtered.slice(offset, offset + limit + 1);
      return {
        runs: page.slice(0, limit).map((record) => structuredClone(record.run)),
        ...(page.length > limit ? { nextCursor: String(offset + limit) } : {}),
      };
    });
  }
}
