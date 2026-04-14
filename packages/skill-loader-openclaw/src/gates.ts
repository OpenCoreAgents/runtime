import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ParsedOpenClawSkill } from "./types.js";

const execFileAsync = promisify(execFile);

export function resolveConfigPath(config: Record<string, unknown>, dotPath: string): unknown {
  return dotPath.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object" && key in (acc as object)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, config);
}

export async function binaryExists(bin: string): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      await execFileAsync("where", [bin], { windowsHide: true });
    } else {
      await execFileAsync("which", [bin]);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a skill passes load-time gates: OS, requires.bins, requires.anyBins,
 * requires.env, requires.config. `metadata.openclaw.always: true` skips other gates.
 */
export async function checkSkillGates(
  parsed: ParsedOpenClawSkill,
  config?: Record<string, unknown>,
): Promise<ParsedOpenClawSkill> {
  const oc = parsed.meta.metadata?.openclaw;
  if (oc?.always) return { ...parsed, eligible: true };

  if (oc?.os?.length) {
    const platform = process.platform;
    if (!oc.os.includes(platform)) {
      return {
        ...parsed,
        eligible: false,
        skipReason: `requires OS ${oc.os.join("|")}, got ${platform}`,
      };
    }
  }

  for (const bin of oc?.requires?.bins ?? []) {
    if (!(await binaryExists(bin))) {
      return { ...parsed, eligible: false, skipReason: `missing required binary: ${bin}` };
    }
  }

  const anyBins = oc?.requires?.anyBins ?? [];
  if (anyBins.length) {
    const checks = await Promise.all(anyBins.map(binaryExists));
    if (!checks.some(Boolean)) {
      return {
        ...parsed,
        eligible: false,
        skipReason: `none of required binaries found: ${anyBins.join(", ")}`,
      };
    }
  }

  for (const envVar of oc?.requires?.env ?? []) {
    if (!process.env[envVar] && !config?.[envVar]) {
      return { ...parsed, eligible: false, skipReason: `missing required env var: ${envVar}` };
    }
  }

  for (const configKey of oc?.requires?.config ?? []) {
    const v = resolveConfigPath(config ?? {}, configKey);
    if (v === undefined || v === null || v === false || v === "") {
      return {
        ...parsed,
        eligible: false,
        skipReason: `missing required config key: ${configKey}`,
      };
    }
  }

  return { ...parsed, eligible: true };
}
