import type { AgentDefinitionPersisted, SkillDefinitionPersisted } from "@opencoreagents/core";
import type { HttpToolConfig } from "@opencoreagents/adapters-http-tool";
import {
  bindDefinitions,
  type DynamicDefinitionsStore,
  type DynamicDefinitionsStoreMethods,
  type ProjectDefinitionsSnapshot,
} from "@opencoreagents/dynamic-definitions";
import type { Redis } from "ioredis";

export interface RedisDynamicDefinitionsStoreOptions {
  /**
   * Key prefix for all definition hashes (default `def`).
   * Full keys: `{prefix}:{projectId}:httpTools|skills|agents` (Redis HASH, field = id, value = JSON).
   */
  keyPrefix?: string;
}

class RedisDefinitionsBackend implements DynamicDefinitionsStoreMethods {
  private readonly prefix: string;

  constructor(
    private readonly redis: Redis,
    options: RedisDynamicDefinitionsStoreOptions = {},
  ) {
    this.prefix = options.keyPrefix?.replace(/:+$/, "") ?? "def";
  }

  private httpHash(projectId: string): string {
    return `${this.prefix}:${projectId}:httpTools`;
  }

  private skillsHash(projectId: string): string {
    return `${this.prefix}:${projectId}:skills`;
  }

  private agentsHash(projectId: string): string {
    return `${this.prefix}:${projectId}:agents`;
  }

  async saveHttpTool(projectId: string, config: HttpToolConfig): Promise<void> {
    await this.redis.hset(this.httpHash(projectId), config.id, JSON.stringify(config));
  }

  async saveSkill(projectId: string, skill: SkillDefinitionPersisted): Promise<void> {
    await this.redis.hset(this.skillsHash(projectId), skill.id, JSON.stringify(skill));
  }

  async saveAgent(projectId: string, agent: AgentDefinitionPersisted): Promise<void> {
    await this.redis.hset(this.agentsHash(projectId), agent.id, JSON.stringify(agent));
  }

  async deleteHttpTool(projectId: string, toolId: string): Promise<boolean> {
    const n = await this.redis.hdel(this.httpHash(projectId), toolId);
    return n > 0;
  }

  async deleteSkill(projectId: string, skillId: string): Promise<boolean> {
    const n = await this.redis.hdel(this.skillsHash(projectId), skillId);
    return n > 0;
  }

  async listHttpTools(projectId: string): Promise<HttpToolConfig[]> {
    const raw = await this.redis.hgetall(this.httpHash(projectId));
    return Object.values(raw).map((json) => JSON.parse(json) as HttpToolConfig);
  }

  async listSkills(projectId: string): Promise<SkillDefinitionPersisted[]> {
    const raw = await this.redis.hgetall(this.skillsHash(projectId));
    return Object.values(raw).map((json) => JSON.parse(json) as SkillDefinitionPersisted);
  }

  async listAgents(projectId: string): Promise<AgentDefinitionPersisted[]> {
    const raw = await this.redis.hgetall(this.agentsHash(projectId));
    return Object.values(raw).map((json) => JSON.parse(json) as AgentDefinitionPersisted);
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

/**
 * **Redis as source of truth** for dynamic agent/skill/HTTP-tool definitions.
 *
 * Use **`store.methods`** for low-level persistence, **`store.Agent` / `store.Skill` / `store.HttpTool`**
 * for the same API as **`bindDefinitions`**. Workers typically pass this instance to **`AgentRuntime`**
 * **`dynamicDefinitionsStore`** so **`dispatch`** hydrates via **`store.methods`**.
 */
export class RedisDynamicDefinitionsStore implements DynamicDefinitionsStore {
  readonly methods: RedisDefinitionsBackend;
  readonly Agent: DynamicDefinitionsStore["Agent"];
  readonly Skill: DynamicDefinitionsStore["Skill"];
  readonly HttpTool: DynamicDefinitionsStore["HttpTool"];
  readonly syncProject: DynamicDefinitionsStore["syncProject"];

  constructor(redis: Redis, options: RedisDynamicDefinitionsStoreOptions = {}) {
    this.methods = new RedisDefinitionsBackend(redis, options);
    const b = bindDefinitions(this.methods);
    this.Agent = b.Agent;
    this.Skill = b.Skill;
    this.HttpTool = b.HttpTool;
    this.syncProject = b.syncProject;
  }
}
