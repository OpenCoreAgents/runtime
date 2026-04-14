import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DiscoverSkillsOptions, ParsedOpenClawSkill } from "./types.js";
import { parseSkillMd } from "./parse.js";

/**
 * Discover `SKILL.md` files: each immediate subdirectory of `dir` that contains `SKILL.md` is one skill.
 */
export async function discoverSkills(
  dir: string,
  options?: DiscoverSkillsOptions,
): Promise<ParsedOpenClawSkill[]> {
  const results: ParsedOpenClawSkill[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const skillMdPath = path.join(dir, entry, "SKILL.md");
    try {
      await fs.access(skillMdPath);
    } catch {
      continue;
    }
    try {
      results.push(await parseSkillMd(skillMdPath));
    } catch (err) {
      options?.onParseError?.(skillMdPath, err);
    }
  }

  return results;
}
