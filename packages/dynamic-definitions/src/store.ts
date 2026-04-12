import type { AgentDefinitionPersisted, SkillDefinitionPersisted } from "@opencoreagents/core";
import type { HttpToolConfig } from "@opencoreagents/adapters-http-tool";

export interface ProjectDefinitionsSnapshot {
  projectId: string;
  httpTools: HttpToolConfig[];
  skills: SkillDefinitionPersisted[];
  agents: AgentDefinitionPersisted[];
}

/**
 * Low-level persistence for definitions (Redis, Postgres, in-memory maps).
 * High-level **`Agent.define` / `Skill.define` / `HttpTool.define`** live on the **`DynamicDefinitionsStore`** facade
 * (`store.Agent`, …); this contract is exposed as **`store.methods`** on that object.
 */
export interface DynamicDefinitionsStoreMethods {
  saveHttpTool(projectId: string, config: HttpToolConfig): Promise<void>;
  saveSkill(projectId: string, skill: SkillDefinitionPersisted): Promise<void>;
  saveAgent(projectId: string, agent: AgentDefinitionPersisted): Promise<void>;
  listHttpTools(projectId: string): Promise<HttpToolConfig[]>;
  listSkills(projectId: string): Promise<SkillDefinitionPersisted[]>;
  listAgents(projectId: string): Promise<AgentDefinitionPersisted[]>;
  getSnapshot(projectId: string): Promise<ProjectDefinitionsSnapshot>;
}

/**
 * In-memory maps per `projectId`. Prefer **`new InMemoryDynamicDefinitionsStore()`** from this package for **`store.Agent`** + **`store.methods`** on one object.
 */
export class InMemoryDefinitionsBackend implements DynamicDefinitionsStoreMethods {
  private readonly httpTools = new Map<string, Map<string, HttpToolConfig>>();
  private readonly skills = new Map<string, Map<string, SkillDefinitionPersisted>>();
  private readonly agents = new Map<string, Map<string, AgentDefinitionPersisted>>();

  async saveHttpTool(projectId: string, config: HttpToolConfig): Promise<void> {
    const m = this.httpTools.get(projectId) ?? new Map<string, HttpToolConfig>();
    m.set(config.id, config);
    this.httpTools.set(projectId, m);
  }

  async saveSkill(projectId: string, skill: SkillDefinitionPersisted): Promise<void> {
    const m = this.skills.get(projectId) ?? new Map<string, SkillDefinitionPersisted>();
    m.set(skill.id, skill);
    this.skills.set(projectId, m);
  }

  async saveAgent(projectId: string, agent: AgentDefinitionPersisted): Promise<void> {
    const m = this.agents.get(projectId) ?? new Map<string, AgentDefinitionPersisted>();
    m.set(agent.id, agent);
    this.agents.set(projectId, m);
  }

  async listHttpTools(projectId: string): Promise<HttpToolConfig[]> {
    return [...(this.httpTools.get(projectId)?.values() ?? [])];
  }

  async listSkills(projectId: string): Promise<SkillDefinitionPersisted[]> {
    return [...(this.skills.get(projectId)?.values() ?? [])];
  }

  async listAgents(projectId: string): Promise<AgentDefinitionPersisted[]> {
    return [...(this.agents.get(projectId)?.values() ?? [])];
  }

  async getSnapshot(projectId: string): Promise<ProjectDefinitionsSnapshot> {
    const [httpTools, skills, agents] = await Promise.all([
      this.listHttpTools(projectId),
      this.listSkills(projectId),
      this.listAgents(projectId),
    ]);
    return { projectId, httpTools, skills, agents };
  }
}
