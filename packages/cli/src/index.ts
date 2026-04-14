import path from "node:path";
import readline from "node:readline/promises";
import { scaffold } from "@opencoreagents/scaffold";
import {
  installClawhubSkill,
  ClawhubInstallError,
} from "@opencoreagents/skill-loader-openclaw";
import type {
  InitProjectOptions,
  ScaffoldAdapterPreset,
  ScaffoldLlmPreset,
  ScaffoldTemplate,
} from "@opencoreagents/scaffold";

function printHelp(): void {
  console.log(`@opencoreagents/cli — project scaffolding

Usage:
  runtime init <name> [options]
  runtime generate agent <id> [options]
  runtime generate tool <id> [options]
  runtime generate skill <id> [options]
  runtime skills install <slug> [options]

Commands:
  init              Create a new project directory with template files.
  generate agent    Add an agent definition (and optional test) under ./agents.
  generate tool     Add a tool definition + handler stub under ./tools.
  generate skill    Add a skill definition under ./skills.
  skills install    Download a ClawHub skill (SKILL.md bundle) into ./skills — no OpenClaw app required.

Init options:
  --template <default|minimal|multi-agent>   (default: default)
  --adapter <upstash|redis|memory>         (default: upstash)
  --llm <openai|anthropic|custom>           (default: openai)
  --package-manager <npm|pnpm|yarn|auto>    (default: auto → pnpm in API)
  --out <dir>                               Project root path (default: <cwd>/<name>)
  --force                                   Overwrite existing files

Generate options (all subcommands):
  --cwd <dir>       Project root (default: current working directory)
  --force           Overwrite existing files

Generate agent:
  --skills <a,b>    Comma-separated skill ids (default: [])
  --tools <a,b>     Comma-separated tool ids (default: system_save_memory,system_get_memory)
  --llm-model <m>   Model id written into generated agent (default: gpt-4o)
  --with-test       Generate tests/<id>.test.ts (default)
  --no-with-test    Skip companion test file

Generate skill:
  --tools <a,b>     Comma-separated tool ids (default: [])

Skills install options:
  --cwd <dir>       Project root (default: current working directory)
  --skills-dir <d>  Folder under cwd for skill folders (default: skills)
  --registry <url>  ClawHub API origin (default: https://clawhub.ai or CLAWHUB_REGISTRY)
  --version <ver>   Semver to install (default: latest from registry)
  --force           Overwrite existing folder; also allows “suspicious” skills without prompting
  --token <t>       Bearer token (optional; or CLAWHUB_TOKEN for private skills)
`);
}

type RawFlags = Record<string, string | boolean>;

function parseArgv(argv: string[]): { positionals: string[]; flags: RawFlags } {
  const positionals: string[] = [];
  const flags: RawFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a === "--no-with-test") {
      flags["with-test"] = false;
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function splitComma(s: string | undefined): string[] {
  if (!s || typeof s !== "string") return [];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function resolveProjectRoot(
  cwd: string,
  flags: RawFlags,
): { ok: true; path: string } | { ok: false; message: string } {
  const raw = flags.cwd;
  if (raw === undefined || raw === true) return { ok: true, path: cwd };
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, message: "--cwd expects a directory path." };
  }
  const p = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  return { ok: true, path: p };
}

function printManifestSummary(label: string, m: { created: string[]; skipped: string[] }): void {
  console.log(label);
  if (m.created.length) {
    console.log("  Created:");
    for (const p of m.created) console.log(`    ${p}`);
  }
  if (m.skipped.length) {
    console.log("  Skipped (already exists, use --force to overwrite):");
    for (const p of m.skipped) console.log(`    ${p}`);
  }
}

async function runInit(
  cwd: string,
  positionals: string[],
  flags: RawFlags,
): Promise<number> {
  const name = positionals[0]?.trim();
  if (!name) {
    console.error("init: missing <name>. Example: runtime init my-project");
    return 1;
  }

  const outRaw = flags.out;
  const projectRoot =
    typeof outRaw === "string" && outRaw.trim()
      ? path.isAbsolute(outRaw)
        ? outRaw
        : path.resolve(cwd, outRaw)
      : path.join(cwd, name);

  const template = (flags.template as string | undefined) as ScaffoldTemplate | undefined;
  const adapter = (flags.adapter as string | undefined) as ScaffoldAdapterPreset | undefined;
  const llm = (flags.llm as string | undefined) as ScaffoldLlmPreset | undefined;
  const pm = flags["package-manager"] as string | undefined;

  let packageManager: InitProjectOptions["packageManager"] = "auto";
  if (pm === "npm" || pm === "pnpm" || pm === "yarn") {
    packageManager = pm;
  } else if (pm === "auto" || pm === undefined) {
    packageManager = "auto";
  } else {
    console.error(`init: invalid --package-manager "${pm}". Use npm, pnpm, yarn, or auto.`);
    return 1;
  }

  const opts: InitProjectOptions = {
    name,
    path: projectRoot,
    template: template ?? "default",
    adapter: adapter ?? "upstash",
    llm: llm ?? "openai",
    packageManager,
    force: flags.force === true,
  };

  const m = await scaffold.initProject(opts);
  printManifestSummary(`✓ Project scaffold at ${projectRoot}`, m);
  console.log(`
  Next steps:
  1. cd ${path.relative(cwd, projectRoot) || "."}
  2. cp .env.example .env   # add API keys
  3. pnpm install           # or npm / yarn
  4. pnpm run dev           # when your template wires a dev script
`);
  return 0;
}

async function runGenerateAgent(
  cwd: string,
  positionals: string[],
  flags: RawFlags,
): Promise<number> {
  const agentId = positionals[0]?.trim();
  if (!agentId) {
    console.error("generate agent: missing <id>. Example: runtime generate agent support-bot");
    return 1;
  }
  const root = resolveProjectRoot(cwd, flags);
  if (!root.ok) {
    console.error(root.message);
    return 1;
  }

  const withTest =
    flags["with-test"] === false ? false : flags["with-test"] === true ? true : true;

  const llmModel =
    typeof flags["llm-model"] === "string" ? flags["llm-model"] : undefined;

  const m = await scaffold.generateAgent({
    projectPath: root.path,
    agentId,
    skills: typeof flags.skills === "string" ? splitComma(flags.skills) : undefined,
    tools: typeof flags.tools === "string" ? splitComma(flags.tools) : undefined,
    withTest,
    llmModel,
    force: flags.force === true,
  });
  printManifestSummary(`✓ generate agent ${agentId}`, m);
  return 0;
}

async function runGenerateTool(
  cwd: string,
  positionals: string[],
  flags: RawFlags,
): Promise<number> {
  const toolId = positionals[0]?.trim();
  if (!toolId) {
    console.error("generate tool: missing <id>. Example: runtime generate tool send-email");
    return 1;
  }
  const root = resolveProjectRoot(cwd, flags);
  if (!root.ok) {
    console.error(root.message);
    return 1;
  }
  const m = await scaffold.generateTool({
    projectPath: root.path,
    toolId,
    force: flags.force === true,
  });
  printManifestSummary(`✓ generate tool ${toolId}`, m);
  return 0;
}

async function runSkillsInstall(
  cwd: string,
  positionals: string[],
  flags: RawFlags,
): Promise<number> {
  const slug = positionals[0]?.trim();
  if (!slug) {
    console.error(
      "skills install: missing <slug>. Example: runtime skills install summarize",
    );
    return 1;
  }
  const root = resolveProjectRoot(cwd, flags);
  if (!root.ok) {
    console.error(root.message);
    return 1;
  }

  const skillsDirRel =
    typeof flags["skills-dir"] === "string" && flags["skills-dir"].trim()
      ? flags["skills-dir"].trim()
      : "skills";
  const skillsDir = path.resolve(root.path, skillsDirRel);

  const registry =
    typeof flags.registry === "string" && flags.registry.trim()
      ? flags.registry.trim()
      : undefined;
  const version =
    typeof flags.version === "string" && flags.version.trim()
      ? flags.version.trim()
      : undefined;
  const force = flags.force === true;
  const token =
    typeof flags.token === "string" && flags.token.trim()
      ? flags.token.trim()
      : undefined;

  const tryInstall = (allowSuspicious: boolean) =>
    installClawhubSkill({
      slug,
      skillsDir,
      registry,
      version,
      force,
      token,
      allowSuspicious: allowSuspicious || force,
    });

  try {
    const r = await tryInstall(false);
    console.log(`OK: ${r.slug}@${r.version} -> ${r.installedPath}`);
    return 0;
  } catch (e) {
    if (
      e instanceof ClawhubInstallError &&
      e.code === "SUSPICIOUS_REQUIRES_FORCE" &&
      process.stdin.isTTY &&
      process.stdout.isTTY &&
      !force
    ) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const ans = (
          await rl.question(
            "This skill is flagged suspicious on ClawHub. Install anyway? [y/N] ",
          )
        )
          .trim()
          .toLowerCase();
        if (ans !== "y" && ans !== "yes") {
          console.error("Installation cancelled.");
          return 1;
        }
      } finally {
        rl.close();
      }
      try {
        const r = await tryInstall(true);
        console.log(`OK: ${r.slug}@${r.version} -> ${r.installedPath}`);
        return 0;
      } catch (e2) {
        console.error(e2 instanceof Error ? e2.message : e2);
        return 1;
      }
    }
    console.error(e instanceof Error ? e.message : e);
    return 1;
  }
}

async function runGenerateSkill(
  cwd: string,
  positionals: string[],
  flags: RawFlags,
): Promise<number> {
  const skillId = positionals[0]?.trim();
  if (!skillId) {
    console.error(
      "generate skill: missing <id>. Example: runtime generate skill intake-summary --tools system_save_memory,system_get_memory",
    );
    return 1;
  }
  const root = resolveProjectRoot(cwd, flags);
  if (!root.ok) {
    console.error(root.message);
    return 1;
  }
  const m = await scaffold.generateSkill({
    projectPath: root.path,
    skillId,
    tools: typeof flags.tools === "string" ? splitComma(flags.tools) : undefined,
    force: flags.force === true,
  });
  printManifestSummary(`✓ generate skill ${skillId}`, m);
  return 0;
}

/**
 * Run the CLI and return an exit code (0 = success). Parses `argv` as `process.argv.slice(2)` would.
 */
export async function runCli(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    return 0;
  }

  const cwd = process.cwd();
  const { positionals, flags } = parseArgv(argv);

  if (positionals[0] === "init") {
    return runInit(cwd, positionals.slice(1), flags);
  }

  if (positionals[0] === "skills" && positionals[1] === "install") {
    return runSkillsInstall(cwd, positionals.slice(2), flags);
  }

  if (positionals[0] === "generate") {
    const sub = positionals[1];
    const rest = positionals.slice(2);
    if (sub === "agent") return runGenerateAgent(cwd, rest, flags);
    if (sub === "tool") return runGenerateTool(cwd, rest, flags);
    if (sub === "skill") return runGenerateSkill(cwd, rest, flags);
    console.error(`Unknown generate target: ${sub ?? "(missing)"}. Use agent, tool, or skill.`);
    return 1;
  }

  console.error(`Unknown command: ${positionals[0]}. Try: runtime --help`);
  return 1;
}
