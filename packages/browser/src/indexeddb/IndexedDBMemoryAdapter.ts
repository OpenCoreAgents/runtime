import type { MemoryAdapter, MemoryScope } from "@opencoreagents/core";
import {
  MEMORY_STORE_NAME,
  openBrowserDatabase,
  requestResult,
  resolveDatabaseName,
  transactionComplete,
  withIndexedDBOperation,
  type IndexedDBAdapterOptions,
} from "./database.js";

interface MemoryRecord {
  id?: number;
  partitionKey: string;
  memoryType: string;
  content: unknown;
  createdAt: number;
}

function storagePartitionKey(scope: MemoryScope, memoryType: string): string {
  const base = `${scope.projectId}:${scope.agentId}`;
  if (scope.endUserId && (memoryType === "longTerm" || memoryType === "vectorMemory")) {
    return `${base}:eu:${scope.endUserId}`;
  }
  return `${base}:sess:${scope.sessionId}`;
}

/** Persistent browser memory with the same partition semantics as `InMemoryMemoryAdapter`. */
export class IndexedDBMemoryAdapter implements MemoryAdapter {
  private readonly databaseName: string;

  constructor(options: IndexedDBAdapterOptions = {}) {
    this.databaseName = resolveDatabaseName(options);
  }

  async save(scope: MemoryScope, memoryType: string, content: unknown): Promise<void> {
    await withIndexedDBOperation("Saving browser memory", async () => {
      const database = await openBrowserDatabase(this.databaseName);
      const transaction = database.transaction(MEMORY_STORE_NAME, "readwrite");
      transaction.objectStore(MEMORY_STORE_NAME).add({
        partitionKey: storagePartitionKey(scope, memoryType),
        memoryType,
        content,
        createdAt: Date.now(),
      } satisfies MemoryRecord);
      await transactionComplete(transaction);
    });
  }

  async query(scope: MemoryScope, memoryType: string, _filter?: unknown): Promise<unknown[]> {
    return withIndexedDBOperation("Querying browser memory", async () => {
      const database = await openBrowserDatabase(this.databaseName);
      const transaction = database.transaction(MEMORY_STORE_NAME, "readonly");
      const index = transaction.objectStore(MEMORY_STORE_NAME).index("partitionType");
      const records = await requestResult(
        index.getAll(IDBKeyRange.only([storagePartitionKey(scope, memoryType), memoryType])),
      ) as MemoryRecord[];
      await transactionComplete(transaction);
      records.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
      return records.map((record) => structuredClone(record.content));
    });
  }

  async delete(scope: MemoryScope, memoryType: string, _filter?: unknown): Promise<void> {
    await withIndexedDBOperation("Deleting browser memory", async () => {
      const database = await openBrowserDatabase(this.databaseName);
      const transaction = database.transaction(MEMORY_STORE_NAME, "readwrite");
      const index = transaction.objectStore(MEMORY_STORE_NAME).index("partitionType");
      const keys = await requestResult(
        index.getAllKeys(IDBKeyRange.only([storagePartitionKey(scope, memoryType), memoryType])),
      );
      const store = transaction.objectStore(MEMORY_STORE_NAME);
      for (const key of keys) store.delete(key);
      await transactionComplete(transaction);
    });
  }

  async getState(_scope: MemoryScope): Promise<unknown> {
    return {};
  }
}
