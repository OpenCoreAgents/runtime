import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { clearAllRegistriesForTests, getSkillDefinition } from "@opencoreagents/core";
import { parseSkillMd, checkSkillGates, discoverSkills, loadOpenClawSkills } from "../src/index.js";

async function writeSkill(parent: string, folder: string, body: string): Promise<void> {
  const dir = path.join(parent, folder);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), body, "utf-8");
}

describe("parseSkillMd", () => {
  it("parses frontmatter and replaces baseDir", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-sk-"));
    const skillDir = path.join(dir, "demo");
    await fs.mkdir(skillDir, { recursive: true });
    const md = `---
name: demo_skill
description: Demo.
---

Run scripts in {baseDir}/scripts.
`;
    const p = path.join(skillDir, "SKILL.md");
    await fs.writeFile(p, md, "utf-8");
    const parsed = await parseSkillMd(p);
    expect(parsed.meta.name).toBe("demo_skill");
    expect(parsed.instructions).toContain(skillDir);
    expect(parsed.instructions).not.toContain("{baseDir}");
  });

  it("accepts leading blank lines before frontmatter", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-sk2-"));
    const skillDir = path.join(dir, "demo");
    await fs.mkdir(skillDir, { recursive: true });
    const md = `

---
name: spaced
description: Ok
---

Hi.
`;
    const p = path.join(skillDir, "SKILL.md");
    await fs.writeFile(p, md, "utf-8");
    const parsed = await parseSkillMd(p);
    expect(parsed.meta.name).toBe("spaced");
    expect(parsed.instructions).toContain("Hi.");
  });
});

describe("checkSkillGates", () => {
  it("passes when openclaw.always is true", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-gate-"));
    await writeSkill(
      dir,
      "x",
      `---
name: x
description: y
metadata:
  openclaw:
    always: true
    requires:
      bins: ["__nonexistent_binary_zz__"]
---

Body
`,
    );
    const parsed = await parseSkillMd(path.join(dir, "x", "SKILL.md"));
    const gated = await checkSkillGates(parsed);
    expect(gated.eligible).toBe(true);
  });
});

describe("loadOpenClawSkills", () => {
  beforeEach(() => {
    clearAllRegistriesForTests();
  });

  it("registers skills from a skills directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oc-load-"));
    await writeSkill(
      root,
      "hello",
      `---
name: hello_world
description: Greets.
---

# Hello
Say hi.
`,
    );
    const { loaded, skipped } = await loadOpenClawSkills({ dirs: [root] });
    expect(skipped).toEqual([]);
    expect(loaded).toEqual(["hello_world"]);
    const def = getSkillDefinition("any-project", "hello_world");
    expect(def?.description).toContain("Say hi.");
  });

  it("registers project-scoped skills under projectId", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oc-proj-"));
    await writeSkill(
      root,
      "p",
      `---
name: proj_only
description: P
---
Hi`,
    );
    await loadOpenClawSkills({
      dirs: [root],
      scope: "project",
      projectId: "my-app",
    });
    expect(getSkillDefinition("my-app", "proj_only")?.description).toContain("Hi");
    expect(getSkillDefinition("other", "proj_only")).toBeUndefined();
  });

  it("dedupes by name with first dir winning", async () => {
    const a = await fs.mkdtemp(path.join(os.tmpdir(), "oc-a-"));
    const b = await fs.mkdtemp(path.join(os.tmpdir(), "oc-b-"));
    await writeSkill(
      a,
      "dup",
      `---
name: same
description: From A
---
A`,
    );
    await writeSkill(
      b,
      "dup",
      `---
name: same
description: From B
---
B`,
    );
    await loadOpenClawSkills({ dirs: [a, b] });
    const def = getSkillDefinition("p", "same");
    expect(def?.description).toContain("From A");
    expect(def?.description).toContain("A");
  });
});

describe("discoverSkills", () => {
  it("returns empty for missing directory", async () => {
    const r = await discoverSkills(path.join(os.tmpdir(), "nope-openclaw-404"));
    expect(r).toEqual([]);
  });

  it("invokes onParseError when SKILL.md is present but invalid", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oc-badfm-"));
    await writeSkill(root, "broken", "not frontmatter\n");
    const errors: { path: string; err: unknown }[] = [];
    const r = await discoverSkills(root, {
      onParseError: (skillMdPath, err) => errors.push({ path: skillMdPath, err }),
    });
    expect(r).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe(path.join(root, "broken", "SKILL.md"));
    expect(String((errors[0]!.err as Error).message)).toMatch(/frontmatter/i);
  });
});
