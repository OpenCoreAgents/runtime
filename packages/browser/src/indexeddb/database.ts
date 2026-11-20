const DATABASE_VERSION = 2;

export const DEFAULT_BROWSER_DATABASE_NAME = "opencoreagents-browser";
export const MEMORY_STORE_NAME = "memories";
export const RUN_STORE_NAME = "runs";
export const DEFINITIONS_STORE_NAME = "definitions";

const openDatabases = new Map<string, Promise<IDBDatabase>>();

export interface IndexedDBAdapterOptions {
  /** Allows applications to isolate local agent data by product or environment. */
  databaseName?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorName(error: unknown): string | undefined {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) return error.name;
  return error instanceof Error ? error.name : undefined;
}

function normalizeIndexedDBError(operation: string, error: unknown): Error {
  const name = errorName(error);
  const message = errorMessage(error);
  if (name === "QuotaExceededError") {
    return new Error(
      `${operation} failed because browser storage quota was exceeded. Free origin storage or use a smaller payload. ${message}`,
      { cause: error },
    );
  }
  if (name === "DataCloneError") {
    return new Error(
      `${operation} failed because the value could not be serialized for IndexedDB. Store plain structured-cloneable data only. ${message}`,
      { cause: error },
    );
  }
  return new Error(`${operation} failed. ${message}`, { cause: error });
}

export async function withIndexedDBOperation<T>(
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw normalizeIndexedDBError(operation, error);
  }
}

function requireIndexedDB(): IDBFactory {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is unavailable in this environment.");
  }
  return indexedDB;
}

export function resolveDatabaseName(options?: IndexedDBAdapterOptions): string {
  const name = options?.databaseName?.trim();
  return name || DEFAULT_BROWSER_DATABASE_NAME;
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

export function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
}

export function openBrowserDatabase(databaseName: string): Promise<IDBDatabase> {
  const cached = openDatabases.get(databaseName);
  if (cached) return cached;

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = requireIndexedDB().open(databaseName, DATABASE_VERSION);
    let settled = false;
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(MEMORY_STORE_NAME)) {
        const memories = database.createObjectStore(MEMORY_STORE_NAME, {
          keyPath: "id",
          autoIncrement: true,
        });
        memories.createIndex("partitionType", ["partitionKey", "memoryType"], {
          unique: false,
        });
      }
      if (!database.objectStoreNames.contains(RUN_STORE_NAME)) {
        const runs = database.createObjectStore(RUN_STORE_NAME, { keyPath: "runId" });
        runs.createIndex("agentId", "agentId", { unique: false });
        runs.createIndex("projectAgentSession", ["projectId", "agentId", "sessionId"], {
          unique: false,
        });
      }
      if (!database.objectStoreNames.contains(DEFINITIONS_STORE_NAME)) {
        const definitions = database.createObjectStore(DEFINITIONS_STORE_NAME, {
          keyPath: ["projectId", "kind", "id"],
        });
        definitions.createIndex("projectKind", ["projectId", "kind"], { unique: false });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      database.onversionchange = () => {
        database.close();
        if (openDatabases.get(databaseName) === promise) {
          openDatabases.delete(databaseName);
        }
      };
      resolve(database);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      if (openDatabases.get(databaseName) === promise) {
        openDatabases.delete(databaseName);
      }
      reject(request.error ?? new Error(`Could not open IndexedDB database ${databaseName}.`));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      if (openDatabases.get(databaseName) === promise) {
        openDatabases.delete(databaseName);
      }
      reject(new Error(`Opening IndexedDB database ${databaseName} was blocked.`));
    };
  });
  openDatabases.set(databaseName, promise);
  return promise;
}

/** Closes this module's cached connection without deleting persisted data. */
export async function closeOpenCoreBrowserDatabase(
  databaseName = DEFAULT_BROWSER_DATABASE_NAME,
): Promise<void> {
  const pending = openDatabases.get(databaseName);
  openDatabases.delete(databaseName);
  if (!pending) return;
  try {
    const database = await pending;
    database.close();
  } catch {
    // A rejected open request has no usable connection to close.
  }
}

/** Closes cached connections and deletes all local OpenCore data in the named database. */
export async function deleteOpenCoreBrowserDatabase(
  databaseName = DEFAULT_BROWSER_DATABASE_NAME,
): Promise<void> {
  await closeOpenCoreBrowserDatabase(databaseName);
  await new Promise<void>((resolve, reject) => {
    const request = requireIndexedDB().deleteDatabase(databaseName);
    let settled = false;
    request.onsuccess = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error(`Could not delete IndexedDB database ${databaseName}.`));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error(`Deleting IndexedDB database ${databaseName} was blocked.`));
    };
  });
}
