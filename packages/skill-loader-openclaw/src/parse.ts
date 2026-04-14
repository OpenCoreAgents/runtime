import * as fs from "node:fs/promises";
import * as path from "node:path";
import yaml from "js-yaml";
import type { OpenClawSkillMeta, ParsedOpenClawSkill } from "./types.js";

function normalizeNewlines(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

function isOpenClawSkillMeta(v: unknown): v is OpenClawSkillMeta {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.name === "string" && typeof o.description === "string";
}

/**
 * Parse a SKILL.md file into structured metadata + instruction body.
 * Expects YAML frontmatter between `---` delimiters (OpenClaw / AgentSkills style).
 */
export async function parseSkillMd(skillMdPath: string): Promise<ParsedOpenClawSkill> {
  const raw = await fs.readFile(skillMdPath, "utf-8");
  const skillDir = path.dirname(skillMdPath);
  const normalized = normalizeNewlines(raw).trimStart();
  const fmMatch = normalized.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error(`SKILL.md at ${skillMdPath} has no valid frontmatter`);
  }
  const loaded = yaml.load(fmMatch[1]);
  if (!isOpenClawSkillMeta(loaded)) {
    throw new Error(`SKILL.md at ${skillMdPath} missing required fields: name, description`);
  }
  const meta = loaded;
  const instructions = fmMatch[2].trim().replace(/\{baseDir\}/g, skillDir);
  return { meta, instructions, skillDir, eligible: true };
}

/** Inline description + instructions for Context Builder / LLM (OpenClaw-style prompt injection). */
export function buildSkillDescription(skill: ParsedOpenClawSkill): string {
  return `${skill.meta.description}\n\n${skill.instructions}`;
}
