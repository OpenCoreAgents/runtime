/**
 * In-process definition registry.
 *
 * All Maps below are **module-level singletons** — they exist only within
 * the current Node.js process. In a cluster of workers, every process must
 * execute the same `Tool.define` / `Skill.define` / `Agent.define` calls
 * at startup so each node has an identical copy.
 *
 * There is no cross-process sync protocol; definitions are **code, not
 * runtime data**. If you add a new definition, redeploy all workers.
 *
 * See docs/reference/core/16-cluster-deployment.md §1.1 for details.
 */
import type { AgentDefinitionPersisted, SkillDefinition, ToolDefinition } from "./types.js";
import type { ToolAdapter } from "../adapters/tool/ToolAdapter.js";

const globalTools = new Map<string, ToolDefinition>();
const projectTools = new Map<string, Map<string, ToolDefinition>>();

const globalSkills = new Map<string, SkillDefinition>();
const projectSkills = new Map<string, Map<string, SkillDefinition>>();

const globalAgents = new Map<string, AgentDefinitionPersisted>();
const projectAgents = new Map<string, Map<string, AgentDefinitionPersisted>>();

const toolHandlers = new Map<string, ToolAdapter>();

export function registerToolDefinition(def: ToolDefinition): void {
  if (def.projectId !== undefined) {
    const m = projectTools.get(def.projectId) ?? new Map<string, ToolDefinition>();
    m.set(def.id, def);
    projectTools.set(def.projectId, m);
  } else {
    globalTools.set(def.id, def);
  }
}

export function registerToolHandler(adapter: ToolAdapter): void {
  toolHandlers.set(adapter.name, adapter);
}

export function getToolDefinition(
  projectId: string,
  id: string,
): ToolDefinition | undefined {
  return projectTools.get(projectId)?.get(id) ?? globalTools.get(id);
}

export function registerSkillDefinition(def: SkillDefinition): void {
  if (def.projectId !== undefined) {
    const m = projectSkills.get(def.projectId) ?? new Map<string, SkillDefinition>();
    m.set(def.id, def);
    projectSkills.set(def.projectId, m);
  } else {
    globalSkills.set(def.id, def);
  }
}

export function getSkillDefinition(
  projectId: string,
  id: string,
): SkillDefinition | undefined {
  return projectSkills.get(projectId)?.get(id) ?? globalSkills.get(id);
}

export function registerAgentDefinition(def: AgentDefinitionPersisted): void {
  if (def.projectId !== undefined) {
    const m = projectAgents.get(def.projectId) ?? new Map<string, AgentDefinitionPersisted>();
    m.set(def.id, def);
    projectAgents.set(def.projectId, m);
  } else {
    globalAgents.set(def.id, def);
  }
}

export function getAgentDefinition(
  projectId: string,
  agentId: string,
): AgentDefinitionPersisted | undefined {
  return projectAgents.get(projectId)?.get(agentId) ?? globalAgents.get(agentId);
}

/** Ids for which {@link getAgentDefinition} would succeed (project-scoped for `projectId` plus global agents). */
export function listAgentIdsForProject(projectId: string): string[] {
  const ids = new Set<string>();
  const inProject = projectAgents.get(projectId);
  if (inProject) for (const id of inProject.keys()) ids.add(id);
  for (const id of globalAgents.keys()) ids.add(id);
  return [...ids].sort();
}

export function resolveToolRegistry(_projectId: string): Map<string, ToolAdapter> {
  return new Map(toolHandlers);
}

/**
 * Removes a **project-scoped** tool definition and its handler (e.g. after deleting an HTTP tool row from the store).
 * Global tools are untouched.
 */
export function unregisterProjectTool(projectId: string, toolId: string): void {
  projectTools.get(projectId)?.delete(toolId);
  toolHandlers.delete(toolId);
}

/** Removes a **project-scoped** skill definition from the in-process registry. */
export function unregisterProjectSkill(projectId: string, skillId: string): void {
  projectSkills.get(projectId)?.delete(skillId);
}

export function clearAllRegistriesForTests(): void {
  globalTools.clear();
  projectTools.clear();
  globalSkills.clear();
  projectSkills.clear();
  globalAgents.clear();
  projectAgents.clear();
  toolHandlers.clear();
}
