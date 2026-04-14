import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  installClawhubSkill,
  ClawhubInstallError,
} from "../src/clawhubInstall.js";

function minimalSkillZip(entries: Record<string, Uint8Array>): Uint8Array {
  return zipSync(entries);
}

describe("installClawhubSkill", () => {
  it("downloads, extracts flat SKILL.md, and hoists nested layout", async () => {
    const skillBody = strToU8(
      "---\nname: z_test\ndescription: Z\n---\n\nok\n",
    );
    const flatZip = minimalSkillZip({ "SKILL.md": skillBody });
    const nestedZip = minimalSkillZip({ "pack/SKILL.md": skillBody });

    for (const [label, zipBytes] of [
      ["flat", flatZip],
      ["nested", nestedZip],
    ] as const) {
      const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), `och-${label}-`));
      const slug = "demo-slug";

      const fetchFn: typeof fetch = async (input) => {
        const u = typeof input === "string" ? input : input.toString();
        if (u.includes(`/api/v1/skills/${slug}`) && !u.includes("/download")) {
          return new Response(
            JSON.stringify({
              latestVersion: { version: "1.0.0" },
              moderation: {},
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (u.includes("/api/v1/download")) {
          return new Response(zipBytes, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      };

      const r = await installClawhubSkill({
        slug,
        skillsDir,
        registry: "https://clawhub.example",
        allowSuspicious: true,
        fetchFn,
      });

      expect(r.version).toBe("1.0.0");
      const md = await fs.readFile(path.join(r.installedPath, "SKILL.md"), "utf8");
      expect(md).toContain("name: z_test");
    }
  });

  it("rejects malware-blocked skills", async () => {
    const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "och-mal-"));
    const fetchFn: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          latestVersion: { version: "1.0.0" },
          moderation: { isMalwareBlocked: true },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    await expect(
      installClawhubSkill({
        slug: "bad",
        skillsDir,
        registry: "https://x.test",
        fetchFn,
      }),
    ).rejects.toMatchObject({ code: "MALWARE_BLOCKED" });
  });

  it("rejects suspicious skills without allowSuspicious", async () => {
    const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "och-sus-"));
    const fetchFn: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          latestVersion: { version: "1.0.0" },
          moderation: { isSuspicious: true },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    await expect(
      installClawhubSkill({
        slug: "sus",
        skillsDir,
        registry: "https://x.test",
        fetchFn,
      }),
    ).rejects.toMatchObject({ code: "SUSPICIOUS_REQUIRES_FORCE" });
  });

  it("throws INVALID_SLUG for path-like input", async () => {
    await expect(
      installClawhubSkill({
        slug: "../x",
        skillsDir: os.tmpdir(),
        fetchFn: async () => new Response("{}", { status: 200 }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_SLUG" });
  });
});

describe("ClawhubInstallError", () => {
  it("is instanceof Error", () => {
    const e = new ClawhubInstallError("x", "NOT_FOUND");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("NOT_FOUND");
  });
});
