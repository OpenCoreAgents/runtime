import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Tool, type ToolContext } from "@opencoreagents/core";

const execFileAsync = promisify(execFile);

/**
 * Split a command string into argv tokens (no shell). Whitespace separates tokens;
 * use double or single quotes to keep spaces inside one argument. No escape sequences.
 */
export function splitExecCommandLine(line: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur.length) {
        parts.push(cur);
        cur = "";
      }
      continue;
    }
    cur += c;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

function sandboxRoot(ctx: ToolContext): string {
  return (
    ctx.fileReadRoot ??
    (typeof process.env.FILE_READ_ROOT === "string" ? process.env.FILE_READ_ROOT : undefined) ??
    os.homedir() ??
    process.cwd()
  );
}

function skillEnvFromContext(ctx: ToolContext): NodeJS.ProcessEnv {
  const bag = ctx.sessionContext?.skillEnv;
  if (bag === null || bag === undefined || typeof bag !== "object") {
    return {};
  }
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(bag as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Registers a global `exec` tool: run a single executable with arguments (no shell).
 * OpenClaw-style skills that reference `exec` expect this. Call once at app startup if you use those skills.
 */
export async function registerOpenClawExecTool(): Promise<void> {
  await Tool.define({
    id: "exec",
    scope: "global",
    description:
      "Execute a command as a single binary plus arguments (no shell). " +
      "Used by OpenClaw-compatible skills that run external programs (git, ffmpeg, scripts). " +
      "Working directory is constrained under the session file-read root (or FILE_READ_ROOT / home).",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Command line: first token is the binary, rest are arguments. " +
            "Split on whitespace; use \"double\" or 'single' quotes for paths with spaces (no shell, no escapes).",
        },
        cwd: { type: "string", description: "Working directory relative to the sandbox root" },
        timeoutMs: { type: "number", default: 30_000 },
      },
      required: ["command"],
    },
    roles: ["agent"],
    execute: async (input: unknown, ctx: ToolContext) => {
      const o = input as { command?: string; cwd?: string; timeoutMs?: number };
      const command = o.command?.trim();
      if (!command) {
        return { stdout: "", stderr: "empty command", exitCode: 1 };
      }
      const timeoutMs = Math.min(o.timeoutMs ?? 30_000, 60_000);
      const safeRoot = path.resolve(sandboxRoot(ctx));
      const safeCwd = o.cwd ? path.resolve(safeRoot, o.cwd) : safeRoot;
      if (!safeCwd.startsWith(safeRoot)) {
        throw new Error(`cwd '${o.cwd}' is outside the sandbox root`);
      }
      const parts = splitExecCommandLine(command);
      const [bin, ...args] = parts;
      if (!bin) {
        return { stdout: "", stderr: "empty command", exitCode: 1 };
      }
      try {
        const { stdout, stderr } = await execFileAsync(bin, args, {
          cwd: safeCwd,
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, ...skillEnvFromContext(ctx) },
          windowsHide: true,
        });
        return {
          stdout: stdout.slice(0, 10_000),
          stderr: stderr.slice(0, 2_000),
          exitCode: 0,
        };
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        return {
          stdout: (err.stdout ?? "").toString().slice(0, 10_000),
          stderr: (err.stderr ?? err.message ?? String(e)).toString().slice(0, 2_000),
          exitCode: typeof err.code === "number" ? err.code : 1,
        };
      }
    },
  });
}
