import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const segment = basename(here);

/**
 * Absolute path to the `skills/` tree (each subfolder contains `SKILL.md` and, after build, `docs/`).
 * - From published `dist/index.js`: `dist/skills`
 * - From `src/` during tests / tsx: repo `skills/` at package root
 */
export const skillsDirectory =
  segment === "src"
    ? join(here, "..", "skills")
    : segment === "dist"
      ? join(here, "skills")
      : join(here, "skills");

/** Stable ids matching `skills/<id>/SKILL.md`. */
export const skillIds = [
  "opencoreagents-workspace",
  "opencoreagents-engine",
  "opencoreagents-rest-workers",
  "opencoreagents-rag-dynamic",
] as const;

export type CodeSkillId = (typeof skillIds)[number];

/**
 * Absolute path to bundled markdown for one skill (`docs/` next to `SKILL.md`).
 * Populated by `scripts/copy-pack.mjs` during `pnpm build`.
 */
export function skillDocsDirectory(skillId: CodeSkillId): string {
  return join(skillsDirectory, skillId, "docs");
}

/**
 * README stubs copied next to `docs/` so `../../packages/...` links from bundled `core/*.md` resolve.
 */
export function skillPackagesDirectory(skillId: CodeSkillId): string {
  return join(skillsDirectory, skillId, "packages");
}
