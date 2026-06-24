import type {
  DynamicDefinitionsStoreMethods,
  ProjectDefinitionsSnapshot,
} from "@opencoreagents/dynamic-definitions";
import {
  DEFINITIONS_STORE_NAME,
  openBrowserDatabase,
  requestResult,
  resolveDatabaseName,
  transactionComplete,
  withIndexedDBOperation,
  type IndexedDBAdapterOptions,
} from "./database.js";

type HttpToolDefinition = ProjectDefinitionsSnapshot["httpTools"][number];
type SkillDefinition = ProjectDefinitionsSnapshot["skills"][number];
type AgentDefinition = ProjectDefinitionsSnapshot["agents"][number];
type DefinitionKind = "httpTool" | "skill" | "agent";

interface StoredDefinition<T = unknown> {
  projectId: string;
  kind: DefinitionKind;
  id: string;
  value: T;
}

/** IndexedDB persistence implementing the dynamic-definitions storage contract. */
export class IndexedDBDynamicDefinitionsStore implements DynamicDefinitionsStoreMethods {
  private readonly databaseName: string;

  constructor(options: IndexedDBAdapterOptions = {}) {
    this.databaseName = resolveDatabaseName(options);
  }

  saveHttpTool(projectId: string, config: HttpToolDefinition): Promise<void> {
    return this.saveDefinition(projectId, "httpTool", config.id, config);
  }

  saveSkill(projectId: string, skill: SkillDefinition): Promise<void> {
    return this.saveDefinition(projectId, "skill", skill.id, skill);
  }

  saveAgent(projectId: string, agent: AgentDefinition): Promise<void> {
    return this.saveDefinition(projectId, "agent", agent.id, agent);
  }

  deleteHttpTool(projectId: string, toolId: string): Promise<boolean> {
    return this.deleteDefinition(projectId, "httpTool", toolId);
  }

  deleteSkill(projectId: string, skillId: string): Promise<boolean> {
    return this.deleteDefinition(projectId, "skill", skillId);
  }

  listHttpTools(projectId: string): Promise<HttpToolDefinition[]> {
    return this.listDefinitions<HttpToolDefinition>(projectId, "httpTool");
  }

  listSkills(projectId: string): Promise<SkillDefinition[]> {
    return this.listDefinitions<SkillDefinition>(projectId, "skill");
  }

  listAgents(projectId: string): Promise<AgentDefinition[]> {
    return this.listDefinitions<AgentDefinition>(projectId, "agent");
  }

  async getSnapshot(projectId: string): Promise<ProjectDefinitionsSnapshot> {
    const [httpTools, skills, agents] = await Promise.all([
      this.listHttpTools(projectId),
      this.listSkills(projectId),
      this.listAgents(projectId),
    ]);
    return { projectId, httpTools, skills, agents };
  }

  private async saveDefinition<T>(
    projectId: string,
    kind: DefinitionKind,
    id: string,
    value: T,
  ): Promise<void> {
    await withIndexedDBOperation("Saving browser dynamic definition", async () => {
      const database = await openBrowserDatabase(this.databaseName);
      const transaction = database.transaction(DEFINITIONS_STORE_NAME, "readwrite");
      transaction.objectStore(DEFINITIONS_STORE_NAME).put({
        projectId,
        kind,
        id,
        value: structuredClone(value),
      } satisfies StoredDefinition<T>);
      await transactionComplete(transaction);
    });
  }

  private async deleteDefinition(
    projectId: string,
    kind: DefinitionKind,
    id: string,
  ): Promise<boolean> {
    return withIndexedDBOperation("Deleting browser dynamic definition", async () => {
      const database = await openBrowserDatabase(this.databaseName);
      const transaction = database.transaction(DEFINITIONS_STORE_NAME, "readwrite");
      const store = transaction.objectStore(DEFINITIONS_STORE_NAME);
      const key: IDBValidKey = [projectId, kind, id];
      const current = await requestResult(store.getKey(key));
      if (current !== undefined) store.delete(key);
      await transactionComplete(transaction);
      return current !== undefined;
    });
  }

  private async listDefinitions<T>(
    projectId: string,
    kind: DefinitionKind,
  ): Promise<T[]> {
    return withIndexedDBOperation("Listing browser dynamic definitions", async () => {
      const database = await openBrowserDatabase(this.databaseName);
      const transaction = database.transaction(DEFINITIONS_STORE_NAME, "readonly");
      const index = transaction.objectStore(DEFINITIONS_STORE_NAME).index("projectKind");
      const records = await requestResult(
        index.getAll(IDBKeyRange.only([projectId, kind])),
      ) as Array<StoredDefinition<T>>;
      await transactionComplete(transaction);
      records.sort((a, b) => a.id.localeCompare(b.id));
      return records.map((record) => structuredClone(record.value));
    });
  }
}
