import "fake-indexeddb/auto";
import { clearAllRegistriesForTests, getAgentDefinition, type Run } from "@opencoreagents/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  IndexedDBMemoryAdapter,
  IndexedDBRunStore,
  IndexedDBDynamicDefinitionsStore,
  closeOpenCoreBrowserDatabase,
  deleteOpenCoreBrowserDatabase,
  hydrateBrowserDynamicDefinitions,
} from "../src/index.js";

const databases = new Set<string>();
let databaseSequence = 0;

function databaseName(label: string): string {
  const name = `opencoreagents-test-${label}-${databaseSequence++}`;
  databases.add(name);
  return name;
}

afterEach(async () => {
  await Promise.all([...databases].map((name) => deleteOpenCoreBrowserDatabase(name)));
  databases.clear();
});

function baseRun(overrides: Partial<Run> = {}): Run {
  return {
    runId: "run-1",
    agentId: "agent-1",
    sessionId: "session-1",
    projectId: "project-1",
    status: "waiting",
    history: [],
    state: { iteration: 0, pending: null, parseAttempts: 0, userInput: "hello" },
    ...overrides,
  };
}

describe("IndexedDBMemoryAdapter", () => {
  it("closes a late connection after a blocked upgrade so retry and deletion remain possible", async () => {
    const name = databaseName("blocked-upgrade");
    const legacyDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const memories = request.result.createObjectStore("memories", {
          keyPath: "id",
          autoIncrement: true,
        });
        memories.createIndex("partitionType", ["partitionKey", "memoryType"]);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const adapter = new IndexedDBMemoryAdapter({ databaseName: name });
    const scope = { projectId: "p", agentId: "a", sessionId: "s" };

    await expect(adapter.save(scope, "working", "first")).rejects.toThrow("was blocked");
    legacyDatabase.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await adapter.save(scope, "working", "retry");
    expect(await adapter.query(scope, "working")).toEqual(["retry"]);
    await closeOpenCoreBrowserDatabase(name);
    await deleteOpenCoreBrowserDatabase(name);
    databases.delete(name);
  });

  it("reopens a closed cached connection without losing data", async () => {
    const name = databaseName("connection-close");
    const adapter = new IndexedDBMemoryAdapter({ databaseName: name });
    const scope = { projectId: "p", agentId: "a", sessionId: "s" };
    await adapter.save(scope, "working", "preserved");

    await closeOpenCoreBrowserDatabase(name);

    expect(await adapter.query(scope, "working")).toEqual(["preserved"]);
  });

  it("rejects deletion clearly when another IndexedDB connection blocks it", async () => {
    const name = databaseName("blocked-delete");
    const adapter = new IndexedDBMemoryAdapter({ databaseName: name });
    const scope = { projectId: "p", agentId: "a", sessionId: "s" };
    await adapter.save(scope, "working", "blocked");
    await closeOpenCoreBrowserDatabase(name);
    const externalDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    await expect(deleteOpenCoreBrowserDatabase(name)).rejects.toThrow("was blocked");

    externalDatabase.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await deleteOpenCoreBrowserDatabase(name);
    databases.delete(name);
  });

  it("persists ordered memory across adapter instances", async () => {
    const name = databaseName("memory-persistence");
    const first = new IndexedDBMemoryAdapter({ databaseName: name });
    const second = new IndexedDBMemoryAdapter({ databaseName: name });
    const scope = { projectId: "p", agentId: "a", sessionId: "s" };

    await first.save(scope, "working", { turn: 1 });
    await first.save(scope, "working", { turn: 2 });

    expect(await second.query(scope, "working")).toEqual([{ turn: 1 }, { turn: 2 }]);
  });

  it("shares long-term memory by end user but keeps working memory session-scoped", async () => {
    const adapter = new IndexedDBMemoryAdapter({ databaseName: databaseName("memory-scope") });
    const first = { projectId: "p", agentId: "a", sessionId: "s1", endUserId: "user-1" };
    const second = { projectId: "p", agentId: "a", sessionId: "s2", endUserId: "user-1" };

    await adapter.save(first, "longTerm", { preference: "dark" });
    await adapter.save(first, "working", { draft: true });

    expect(await adapter.query(second, "longTerm")).toEqual([{ preference: "dark" }]);
    expect(await adapter.query(second, "working")).toEqual([]);
  });

  it("deletes only the selected memory partition and type", async () => {
    const adapter = new IndexedDBMemoryAdapter({ databaseName: databaseName("memory-delete") });
    const scope = { projectId: "p", agentId: "a", sessionId: "s" };
    await adapter.save(scope, "working", "remove");
    await adapter.save(scope, "shortTerm", "keep");

    await adapter.delete(scope, "working");

    expect(await adapter.query(scope, "working")).toEqual([]);
    expect(await adapter.query(scope, "shortTerm")).toEqual(["keep"]);
  });

  it("reports unsupported memory payloads with an actionable serialization error", async () => {
    const adapter = new IndexedDBMemoryAdapter({
      databaseName: databaseName("memory-unserializable"),
    });
    const scope = { projectId: "p", agentId: "a", sessionId: "s" };

    await expect(adapter.save(scope, "working", { callback: () => "nope" })).rejects.toThrow(
      "could not be serialized for IndexedDB",
    );
  });
});

describe("IndexedDBRunStore", () => {
  it("persists cloned runs across store instances", async () => {
    const name = databaseName("run-persistence");
    const first = new IndexedDBRunStore({ databaseName: name });
    const second = new IndexedDBRunStore({ databaseName: name });
    const run = baseRun();

    await first.save(run);
    run.status = "failed";

    expect((await second.load("run-1"))?.status).toBe("waiting");
  });

  it("performs atomic status compare-and-swap", async () => {
    const store = new IndexedDBRunStore({ databaseName: databaseName("run-cas") });
    await store.save(baseRun());
    const completed = baseRun({ status: "completed" });
    const failed = baseRun({ status: "failed" });

    const outcomes = await Promise.all([
      store.saveIfStatus(completed, "waiting"),
      store.saveIfStatus(failed, "waiting"),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(["completed", "failed"]).toContain((await store.load("run-1"))?.status);
  });

  it("lists by session with tenant isolation, ordering, and pagination", async () => {
    const store = new IndexedDBRunStore({ databaseName: databaseName("run-list") });
    await store.save(
      baseRun({
        runId: "old",
        status: "completed",
        history: [
          { type: "result", content: "old", meta: { ts: "2026-01-01T00:00:00.000Z", source: "engine" } },
        ],
      }),
    );
    await store.save(
      baseRun({
        runId: "new",
        history: [
          { type: "result", content: "new", meta: { ts: "2026-01-02T00:00:00.000Z", source: "engine" } },
        ],
      }),
    );
    await store.save(baseRun({ runId: "tenant", tenantId: "tenant-1" }));

    const firstPage = await store.listByAgentAndSession("project-1", "agent-1", "session-1", {
      limit: 1,
    });
    expect(firstPage.runs.map((run) => run.runId)).toEqual(["new"]);
    expect(firstPage.nextCursor).toBe("1");

    const secondPage = await store.listByAgentAndSession("project-1", "agent-1", "session-1", {
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.runs.map((run) => run.runId)).toEqual(["old"]);

    const tenantRuns = await store.listByAgentAndSession(
      "project-1",
      "agent-1",
      "session-1",
      { tenantId: "tenant-1" },
    );
    expect(tenantRuns.runs.map((run) => run.runId)).toEqual(["tenant"]);
  });

  it("deletes runs", async () => {
    const store = new IndexedDBRunStore({ databaseName: databaseName("run-delete") });
    await store.save(baseRun());
    await store.delete("run-1");
    expect(await store.load("run-1")).toBeNull();
  });

  it("reports unsupported run payloads with an actionable serialization error", async () => {
    const store = new IndexedDBRunStore({ databaseName: databaseName("run-unserializable") });

    await expect(
      store.save(baseRun({ state: { callback: () => "nope" } })),
    ).rejects.toThrow("could not be serialized for IndexedDB");
  });
});

describe("IndexedDBDynamicDefinitionsStore", () => {
  it("upgrades a version 1 database without removing existing memory", async () => {
    const name = databaseName("definitions-migration");
    const legacyDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        const memories = database.createObjectStore("memories", {
          keyPath: "id",
          autoIncrement: true,
        });
        memories.createIndex("partitionType", ["partitionKey", "memoryType"]);
        const runs = database.createObjectStore("runs", { keyPath: "runId" });
        runs.createIndex("agentId", "agentId");
        runs.createIndex("projectAgentSession", ["projectId", "agentId", "sessionId"]);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    legacyDatabase.close();

    const memory = new IndexedDBMemoryAdapter({ databaseName: name });
    const definitions = new IndexedDBDynamicDefinitionsStore({ databaseName: name });
    const scope = { projectId: "p", agentId: "a", sessionId: "s" };
    await memory.save(scope, "working", "preserved");
    await definitions.saveAgent("p", {
      id: "a",
      projectId: "p",
      systemPrompt: "Persisted.",
      tools: [],
      llm: { provider: "local", model: "test-model" },
    });

    expect(await memory.query(scope, "working")).toEqual(["preserved"]);
    expect((await definitions.listAgents("p")).map((agent) => agent.id)).toEqual(["a"]);
  });

  it("persists project definitions and returns snapshots", async () => {
    const name = databaseName("definitions-snapshot");
    const first = new IndexedDBDynamicDefinitionsStore({ databaseName: name });
    const second = new IndexedDBDynamicDefinitionsStore({ databaseName: name });
    await first.saveHttpTool("project-1", {
      id: "quote",
      projectId: "project-1",
      http: { method: "GET", url: "https://example.com/quote" },
    });
    await first.saveSkill("project-1", {
      id: "analysis",
      projectId: "project-1",
      tools: ["quote"],
    });
    await first.saveAgent("project-1", {
      id: "analyst",
      projectId: "project-1",
      systemPrompt: "Analyze locally.",
      skills: ["analysis"],
      tools: [],
      llm: { provider: "local", model: "test-model" },
    });

    const snapshot = await second.getSnapshot("project-1");
    expect(snapshot.httpTools.map((tool) => tool.id)).toEqual(["quote"]);
    expect(snapshot.skills.map((skill) => skill.id)).toEqual(["analysis"]);
    expect(snapshot.agents.map((agent) => agent.id)).toEqual(["analyst"]);
  });

  it("deletes stored tools and skills with existence results", async () => {
    const store = new IndexedDBDynamicDefinitionsStore({
      databaseName: databaseName("definitions-delete"),
    });
    await store.saveSkill("project-1", { id: "skill", projectId: "project-1", tools: [] });

    expect(await store.deleteSkill("project-1", "skill")).toBe(true);
    expect(await store.deleteSkill("project-1", "skill")).toBe(false);
    expect(await store.deleteHttpTool("project-1", "missing")).toBe(false);
  });

  it("hydrates a persisted agent into the core registry", async () => {
    const store = new IndexedDBDynamicDefinitionsStore({
      databaseName: databaseName("definitions-hydrate"),
    });
    await store.saveAgent("project-1", {
      id: "local-agent",
      projectId: "project-1",
      systemPrompt: "Run locally.",
      tools: [],
      llm: { provider: "local", model: "test-model" },
    });
    clearAllRegistriesForTests();

    await hydrateBrowserDynamicDefinitions(store, "project-1", "local-agent");

    expect(getAgentDefinition("project-1", "local-agent")?.systemPrompt).toBe("Run locally.");
    clearAllRegistriesForTests();
  });

  it("reports unsupported definition payloads with an actionable serialization error", async () => {
    const store = new IndexedDBDynamicDefinitionsStore({
      databaseName: databaseName("definitions-unserializable"),
    });

    await expect(
      store.saveAgent("project-1", {
        id: "invalid",
        projectId: "project-1",
        systemPrompt: "Invalid.",
        tools: [],
        llm: { provider: "local", model: "test-model" },
        callback: () => "nope",
      } as never),
    ).rejects.toThrow("could not be serialized for IndexedDB");
  });
});
