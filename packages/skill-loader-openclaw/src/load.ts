import { Skill } from "@opencoreagents/core";
import type {
  LoadOpenClawSkillsOptions,
  LoadOpenClawSkillsResult,
  ParsedOpenClawSkill,
} from "./types.js";
import { buildSkillDescription } from "./parse.js";
import { checkSkillGates } from "./gates.js";
import { discoverSkills } from "./discover.js";

function skillDefinitionFor(
  gated: ParsedOpenClawSkill,
  scope: "global" | "project",
  projectId: string | undefined,
): Parameters<typeof Skill.define>[0] {
  const base = {
    id: gated.meta.name,
    tools: [] as string[],
    description: buildSkillDescription(gated),
    roles: ["agent"],
  };
  if (scope === "project") {
    if (!projectId) {
      throw new Error("loadOpenClawSkills: projectId is required when scope is \"project\"");
    }
    return { ...base, projectId };
  }
  return { ...base, scope: "global" as const };
}

/**
 * Load eligible OpenClaw-compatible skills from `dirs` and register them via {@link Skill.define}.
 * Same skill `name` from a later directory is ignored (first directory wins). A name is reserved
 * from the first directory that defines it even when that copy is skipped by gates.
 */
export async function loadOpenClawSkills(
  options: LoadOpenClawSkillsOptions,
): Promise<LoadOpenClawSkillsResult> {
  const {
    dirs,
    config,
    scope = "global",
    projectId,
    onSkipped,
    onLoaded,
    onSkillParseError,
  } = options;
  const loaded: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    const parsedList = await discoverSkills(dir, {
      onParseError: onSkillParseError,
    });
    for (const skill of parsedList) {
      const { name } = skill.meta;
      if (seen.has(name)) continue;
      seen.add(name);

      const gated = await checkSkillGates(skill, config);
      if (!gated.eligible) {
        const reason = gated.skipReason ?? "unknown";
        skipped.push({ name, reason });
        onSkipped?.(name, reason);
        continue;
      }

      await Skill.define(skillDefinitionFor(gated, scope, projectId));
      loaded.push(name);
      onLoaded?.(name);
    }
  }

  return { loaded, skipped };
}
