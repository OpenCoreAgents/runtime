import { registerHttpToolsFromDefinitions, type HttpToolConfig } from "@opencoreagents/adapters-http-tool";
import {
  Agent,
  Skill,
  type AgentDefinitionPersisted,
  type SkillDefinitionPersisted,
} from "@opencoreagents/core";
import {
  InMemoryDefinitionsBackend,
  type DynamicDefinitionsStoreMethods,
} from "./store.js";

export interface HttpToolSecretsOptions {
  /** Passed to {@link registerHttpToolsFromDefinitions} for `{{secret:*}}` templates. */
  secrets?: Record<string, string>;
}

function requiredProjectId(entity: { projectId?: string }, kind: string): string {
  const pid = entity.projectId;
  if (typeof pid !== "string" || !pid.trim()) {
    throw new Error(`${kind}: projectId is required on the definition object`);
  }
  return pid;
}

/**
 * Store-bound API: {@link DefinitionsBinding.Agent.define}, {@link DefinitionsBinding.Skill.define},
 * {@link DefinitionsBinding.HttpTool.define} — same shapes as core `*.define`, with **`projectId` on each payload**.
 * {@link DefinitionsBinding.Agent.prepare} runs the per-job store → registry path (see {@link hydrateAgentDefinitionsFromStore}).
 */
export interface DefinitionsBinding {
  readonly Agent: {
    define(agent: AgentDefinitionPersisted): Promise<void>;
    prepare(
      selector: { projectId: string; agentId: string },
      options?: HttpToolSecretsOptions,
    ): Promise<void>;
  };
  readonly Skill: {
    define(skill: SkillDefinitionPersisted): Promise<void>;
  };
  readonly HttpTool: {
    define(config: HttpToolConfig, options?: HttpToolSecretsOptions): Promise<void>;
  };
  /** Full-project replay into the registry (optional warm cache); prefer {@link DefinitionsBinding.Agent.prepare} per job on workers. */
  syncProject(projectId: string, options?: HttpToolSecretsOptions): Promise<void>;
}

/**
 * Facade: **`store.methods`** for persistence ({@link DynamicDefinitionsStoreMethods}), **`store.Agent`** /
 * **`store.Skill`** / **`store.HttpTool`** / **`store.syncProject`** for the same API as {@link bindDefinitions}.
 */
export interface DynamicDefinitionsStore extends DefinitionsBinding {
  readonly methods: DynamicDefinitionsStoreMethods;
}

/** Accepts a bare methods implementation or a full {@link DynamicDefinitionsStore} facade. */
export type DefinitionsStoreInput = DynamicDefinitionsStoreMethods | DynamicDefinitionsStore;

export function resolveDefinitionsStoreMethods(
  store: DefinitionsStoreInput,
): DynamicDefinitionsStoreMethods {
  if (typeof store === "object" && store !== null && "methods" in store) {
    const { methods } = store as DynamicDefinitionsStore;
    if (methods != null && typeof methods === "object") return methods;
  }
  return store as DynamicDefinitionsStoreMethods;
}

/**
 * Bind **`Agent` / `Skill` / `HttpTool` / `syncProject`** to persistence. Accepts a bare
 * {@link DynamicDefinitionsStoreMethods} or a {@link DynamicDefinitionsStore} facade (resolves **`store.methods`**).
 * Prefer constructing **`InMemoryDynamicDefinitionsStore`** / **`RedisDynamicDefinitionsStore`** / **`createDynamicDefinitionsStore`**
 * so you do not need this call for the common case.
 */
export function bindDefinitions(store: DefinitionsStoreInput): DefinitionsBinding {
  const methods = resolveDefinitionsStoreMethods(store);
  return {
    Agent: {
      define: async (agent) =>
        upsertAgentDynamic(methods, requiredProjectId(agent, "Agent.define"), agent),
      prepare: (selector, options) =>
        hydrateAgentDefinitionsFromStore(methods, selector.projectId, selector.agentId, options ?? {}),
    },
    Skill: {
      define: async (skill) =>
        upsertSkillDynamic(methods, requiredProjectId(skill, "Skill.define"), skill),
    },
    HttpTool: {
      define: async (config, options) =>
        upsertHttpToolDynamic(methods, requiredProjectId(config, "HttpTool.define"), config, options ?? {}),
    },
    syncProject: (projectId, options) =>
      syncProjectDefinitionsToRegistry(methods, projectId, options ?? {}),
  };
}

export function createDynamicDefinitionsStore(
  methods: DynamicDefinitionsStoreMethods,
): DynamicDefinitionsStore {
  const b = bindDefinitions(methods);
  return {
    methods,
    Agent: b.Agent,
    Skill: b.Skill,
    HttpTool: b.HttpTool,
    syncProject: b.syncProject,
  };
}

/** In-memory {@link DynamicDefinitionsStore} (maps + **`Agent` / `Skill` / `HttpTool`** on the same object). */
export class InMemoryDynamicDefinitionsStore implements DynamicDefinitionsStore {
  readonly methods: InMemoryDefinitionsBackend;
  readonly Agent: DefinitionsBinding["Agent"];
  readonly Skill: DefinitionsBinding["Skill"];
  readonly HttpTool: DefinitionsBinding["HttpTool"];
  readonly syncProject: DefinitionsBinding["syncProject"];

  constructor() {
    this.methods = new InMemoryDefinitionsBackend();
    const b = bindDefinitions(this.methods);
    this.Agent = b.Agent;
    this.Skill = b.Skill;
    this.HttpTool = b.HttpTool;
    this.syncProject = b.syncProject;
  }
}

function assertProjectId(entity: { projectId?: string }, projectId: string, kind: string): void {
  if (entity.projectId !== undefined && entity.projectId !== projectId) {
    throw new Error(`${kind} projectId mismatch: body has ${entity.projectId}, path has ${projectId}`);
  }
}

/**
 * Dynamic definitions are always project-scoped. `scope: "global"` is reserved for built-ins and
 * explicit `Tool.define` / `Skill.define` in application code — never for store/REST rows.
 */
function assertNotGlobalScope(entity: { scope?: "global" }, kind: string): void {
  if (entity.scope === "global") {
    throw new Error(
      `${kind}: scope "global" is not allowed for dynamic definitions. Register global tools/skills in code (built-ins or explicit Tool.define / Skill.define), not via the store or REST.`,
    );
  }
}

function normalizeProjectScoped<T extends { projectId?: string; scope?: "global" }>(
  entity: T,
  projectId: string,
  kind: string,
): Omit<T, "scope"> & { projectId: string } {
  assertProjectId(entity, projectId, kind);
  assertNotGlobalScope(entity, kind);
  const { scope: _scope, ...rest } = entity;
  return { ...rest, projectId } as Omit<T, "scope"> & { projectId: string };
}

/** Agents from the store are project-scoped; strip `scope` if present (same rules as skills/tools). */
function normalizeAgentDynamic(
  entity: AgentDefinitionPersisted,
  projectId: string,
): AgentDefinitionPersisted {
  assertProjectId(entity, projectId, "AgentDefinitionPersisted");
  assertNotGlobalScope(entity as { scope?: "global" }, "AgentDefinitionPersisted");
  const { scope: _scope, ...rest } = entity as AgentDefinitionPersisted & { scope?: "global" };
  return { ...rest, projectId };
}

/**
 * Persists an HTTP tool and registers it in the in-process registry (schema + handler).
 */
export async function upsertHttpToolDynamic(
  store: DefinitionsStoreInput,
  projectId: string,
  config: HttpToolConfig,
  options: HttpToolSecretsOptions = {},
): Promise<void> {
  const m = resolveDefinitionsStoreMethods(store);
  const normalized = normalizeProjectScoped(config, projectId, "HttpToolConfig");
  await m.saveHttpTool(projectId, normalized);
  await registerHttpToolsFromDefinitions([normalized], { secrets: options.secrets ?? {} });
}

/**
 * Persists a skill (JSON metadata only; no imperative `execute` from REST) and registers it.
 */
export async function upsertSkillDynamic(
  store: DefinitionsStoreInput,
  projectId: string,
  skill: SkillDefinitionPersisted,
): Promise<void> {
  const m = resolveDefinitionsStoreMethods(store);
  const normalized = normalizeProjectScoped(skill, projectId, "SkillDefinitionPersisted");
  await m.saveSkill(projectId, normalized);
  await Skill.define(normalized);
}

/**
 * Persists an agent and registers it.
 */
export async function upsertAgentDynamic(
  store: DefinitionsStoreInput,
  projectId: string,
  agent: AgentDefinitionPersisted,
): Promise<void> {
  const m = resolveDefinitionsStoreMethods(store);
  const normalized = normalizeAgentDynamic(agent, projectId);
  await m.saveAgent(projectId, normalized);
  await Agent.define(normalized);
}

/**
 * Loads **only** the definitions needed for one agent (from the store — e.g. Redis) and registers them
 * in the **current** process. Call this **per job** (or once per run) on workers that do **not** keep a
 * full local catalog: the store remains the source of truth; the registry is just a local materialization.
 *
 * - Every **`agent.skills`** id **must** exist in the store; otherwise throws (fail fast — queue can retry or DLQ).
 * - Resolves **`agent.tools`** plus **`skill.tools`** for those skills.
 * - Registers **HTTP tools** from the store that appear in that set. Tool ids **not** in the store are
 *   assumed to be **built-ins** (e.g. `system_*`) already registered by **`AgentRuntime`** / RAG.
 * - Order: HTTP tools → skills → agent (same as full sync).
 */
export async function hydrateAgentDefinitionsFromStore(
  store: DefinitionsStoreInput,
  projectId: string,
  agentId: string,
  options: HttpToolSecretsOptions = {},
): Promise<void> {
  const m = resolveDefinitionsStoreMethods(store);
  const agents = await m.listAgents(projectId);
  const agentRaw = agents.find((a) => a.id === agentId);
  if (!agentRaw) {
    throw new Error(`hydrateAgentDefinitionsFromStore: agent not found in store: ${agentId} (project ${projectId})`);
  }
  const agent = normalizeAgentDynamic(agentRaw, projectId);

  const skillsById = new Map(
    (await m.listSkills(projectId)).map((s) => [s.id, normalizeProjectScoped(s, projectId, "SkillDefinitionPersisted")]),
  );

  for (const sid of agent.skills ?? []) {
    if (!skillsById.has(sid)) {
      throw new Error(
        `hydrateAgentDefinitionsFromStore: skill not found in store: "${sid}" (agent "${agentId}", project "${projectId}")`,
      );
    }
  }

  const toolIds = new Set(agent.tools ?? []);
  for (const sid of agent.skills ?? []) {
    const sk = skillsById.get(sid)!;
    for (const tid of sk.tools) {
      toolIds.add(tid);
    }
  }

  const httpById = new Map(
    (await m.listHttpTools(projectId)).map((t) => [t.id, normalizeProjectScoped(t, projectId, "HttpToolConfig")]),
  );
  const httpTools: HttpToolConfig[] = [];
  for (const tid of toolIds) {
    const row = httpById.get(tid);
    if (row) {
      httpTools.push(row);
    }
  }

  if (httpTools.length > 0) {
    await registerHttpToolsFromDefinitions(httpTools, { secrets: options.secrets ?? {} });
  }

  const skills: SkillDefinitionPersisted[] = [];
  for (const sid of agent.skills ?? []) {
    skills.push(skillsById.get(sid)!);
  }
  if (skills.length > 0) {
    await Skill.defineBatch(skills, {});
  }

  await Agent.define(agent);
}

/**
 * Re-applies **every** stored definition for the project (optional **warm cache** at boot, dev, or admin).
 * Workers that treat the store as authoritative usually prefer {@link hydrateAgentDefinitionsFromStore}
 * **per job** instead of syncing the whole project.
 */
export async function syncProjectDefinitionsToRegistry(
  store: DefinitionsStoreInput,
  projectId: string,
  options: HttpToolSecretsOptions = {},
): Promise<void> {
  const m = resolveDefinitionsStoreMethods(store);
  const httpTools = (await m.listHttpTools(projectId)).map((t) =>
    normalizeProjectScoped(t, projectId, "HttpToolConfig"),
  );
  const skills = (await m.listSkills(projectId)).map((s) =>
    normalizeProjectScoped(s, projectId, "SkillDefinitionPersisted"),
  );
  const agents = (await m.listAgents(projectId)).map((a) => normalizeAgentDynamic(a, projectId));

  if (httpTools.length > 0) {
    await registerHttpToolsFromDefinitions(httpTools, { secrets: options.secrets ?? {} });
  }
  if (skills.length > 0) {
    await Skill.defineBatch(skills, {});
  }
  for (const agent of agents) {
    await Agent.define(agent);
  }
}
