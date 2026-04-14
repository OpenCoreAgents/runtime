import * as fs from "node:fs/promises";
import * as path from "node:path";
import { unzipSync } from "fflate";

const DEFAULT_REGISTRY = "https://clawhub.ai";
const FETCH_TIMEOUT_MS = 60_000;

export class ClawhubInstallError extends Error {
  constructor(
    message: string,
    readonly code?: "MALWARE_BLOCKED" | "SUSPICIOUS_REQUIRES_FORCE" | "NOT_FOUND" | "INVALID_SLUG",
  ) {
    super(message);
    this.name = "ClawhubInstallError";
  }
}

export interface InstallClawhubSkillOptions {
  /** ClawHub skill slug (no `/`, `\\`, or `..`). */
  slug: string;
  /** Parent directory; skill is installed to `${skillsDir}/${slug}/`. */
  skillsDir: string;
  /** Registry origin, e.g. `https://clawhub.ai`. Overridable via `CLAWHUB_REGISTRY`. */
  registry?: string;
  /** Semver; default = latest from registry. */
  version?: string;
  /** Overwrite existing `${skillsDir}/${slug}` after removing it. */
  force?: boolean;
  /** Bearer token (private skills / same behavior as ClawHub CLI). */
  token?: string;
  /**
   * When the registry marks the skill as suspicious, installation proceeds only if `true`
   * (equivalent to ClawHub CLI `--force` in non-interactive mode).
   */
  allowSuspicious?: boolean;
  fetchFn?: typeof fetch;
}

export interface InstallClawhubSkillResult {
  installedPath: string;
  slug: string;
  version: string;
}

function registryBaseUrl(registry: string): string {
  const t = registry.trim();
  return t.endsWith("/") ? t.slice(0, -1) : t;
}

function skillUrl(registry: string, slug: string): string {
  return `${registryBaseUrl(registry)}/api/v1/skills/${encodeURIComponent(slug)}`;
}

function downloadUrl(registry: string, slug: string, version: string): string {
  const u = new URL(`${registryBaseUrl(registry)}/api/v1/download`);
  u.searchParams.set("slug", slug);
  u.searchParams.set("version", version);
  return u.toString();
}

function sanitizeZipEntryPath(raw: string): string | null {
  const normalized = raw.replace(/^\.\/+/, "").replace(/^\/+/, "");
  if (!normalized || normalized.endsWith("/")) return null;
  if (normalized.includes("..") || normalized.includes("\\")) return null;
  return normalized;
}

async function extractZipToDir(zipBytes: Uint8Array, targetDir: string): Promise<void> {
  const entries = unzipSync(zipBytes);
  await fs.mkdir(targetDir, { recursive: true });
  for (const [rawPath, data] of Object.entries(entries)) {
    const safePath = sanitizeZipEntryPath(rawPath);
    if (!safePath) continue;
    const outPath = path.join(targetDir, safePath);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, data);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * If the bundle used a single top-level folder (e.g. `pack/SKILL.md`), hoist files so
 * `SKILL.md` lives directly under `skillRoot` — matches `discoverSkills` layout.
 */
async function hoistNestedSkillRoot(skillRoot: string): Promise<void> {
  const direct = path.join(skillRoot, "SKILL.md");
  if (await pathExists(direct)) return;

  const entries = await fs.readdir(skillRoot, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length !== 1) return;

  const inner = path.join(skillRoot, dirs[0]!.name);
  if (!(await pathExists(path.join(inner, "SKILL.md")))) return;

  const names = await fs.readdir(inner);
  for (const name of names) {
    await fs.rename(path.join(inner, name), path.join(skillRoot, name));
  }
  await fs.rm(inner, { recursive: true, force: true });
}

interface SkillMetaJson {
  latestVersion?: { version?: string };
  moderation?: {
    isMalwareBlocked?: boolean;
    isSuspicious?: boolean;
  };
}

async function fetchJson(
  url: string,
  token: string | undefined,
  fetchFn: typeof fetch,
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { method: "GET", headers, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new ClawhubInstallError(
        text.trim() || `HTTP ${res.status} ${url}`,
        res.status === 404 ? "NOT_FOUND" : undefined,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ClawhubInstallError(`Invalid JSON from ${url}`);
    }
  } finally {
    clearTimeout(t);
  }
}

async function fetchZip(
  url: string,
  token: string | undefined,
  fetchFn: typeof fetch,
): Promise<Uint8Array> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { method: "GET", headers, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ClawhubInstallError(text.trim() || `HTTP ${res.status} download failed`);
    }
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

function normalizeSlug(raw: string): string {
  const slug = raw.trim();
  if (!slug) throw new ClawhubInstallError("Slug is required", "INVALID_SLUG");
  if (slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    throw new ClawhubInstallError(`Invalid slug: ${slug}`, "INVALID_SLUG");
  }
  return slug;
}

/**
 * Download and extract a public (or token-authorized) ClawHub skill into `skillsDir/<slug>/`.
 * Uses the same HTTP API as the official `clawhub` CLI — **OpenClaw is not required**.
 */
export async function installClawhubSkill(
  options: InstallClawhubSkillOptions,
): Promise<InstallClawhubSkillResult> {
  const slug = normalizeSlug(options.slug);
  const registry =
    options.registry?.trim() ||
    (typeof process.env.CLAWHUB_REGISTRY === "string" && process.env.CLAWHUB_REGISTRY.trim()) ||
    DEFAULT_REGISTRY;
  const token = options.token ?? process.env.CLAWHUB_TOKEN;
  const fetchFn = options.fetchFn ?? fetch;

  const target = path.resolve(options.skillsDir, slug);
  const parent = path.resolve(options.skillsDir);
  await fs.mkdir(parent, { recursive: true });

  if (!options.force && (await pathExists(target))) {
    throw new ClawhubInstallError(
      `Already installed: ${target} (use force option to overwrite)`,
    );
  }

  const metaUnknown = await fetchJson(skillUrl(registry, slug), token, fetchFn);
  const skillMeta = metaUnknown as SkillMetaJson;

  if (skillMeta.moderation?.isMalwareBlocked) {
    throw new ClawhubInstallError(
      "This skill is blocked as malware and cannot be installed.",
      "MALWARE_BLOCKED",
    );
  }

  if (skillMeta.moderation?.isSuspicious && !options.allowSuspicious) {
    throw new ClawhubInstallError(
      'Skill is flagged as suspicious by ClawHub. Re-run with allowSuspicious / CLI --force after review.',
      "SUSPICIOUS_REQUIRES_FORCE",
    );
  }

  const resolvedVersion =
    options.version?.trim() || skillMeta.latestVersion?.version?.trim() || "";
  if (!resolvedVersion) {
    throw new ClawhubInstallError("Could not resolve skill version from registry.");
  }

  if (options.force && (await pathExists(target))) {
    await fs.rm(target, { recursive: true, force: true });
  }

  const zipUrl = downloadUrl(registry, slug, resolvedVersion);
  const zipBytes = await fetchZip(zipUrl, token, fetchFn);
  await extractZipToDir(zipBytes, target);
  await hoistNestedSkillRoot(target);

  if (!(await pathExists(path.join(target, "SKILL.md")))) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    throw new ClawhubInstallError(
      `Extracted bundle has no SKILL.md at ${target} (after hoisting).`,
    );
  }

  return { installedPath: target, slug, version: resolvedVersion };
}
