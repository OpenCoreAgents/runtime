import { describe, it, expect, beforeEach } from "vitest";
import { clearAllRegistriesForTests, Skill } from "../src/index.js";
import { getSkillDefinition } from "../src/define/registry.js";
import type { SkillDefinitionPersisted } from "../src/types.js";

beforeEach(() => {
  clearAllRegistriesForTests();
});

describe("Skill.define (incl. store JSON + code execute)", () => {
  it("define merges second-arg execute into persisted metadata", async () => {
    const persisted: SkillDefinitionPersisted = {
      id: "sk-h1",
      projectId: "p1",
      tools: ["t1"],
      description: "from store",
    };
    const exec = async () => "ok";
    await Skill.define(persisted, exec);
    const def = getSkillDefinition("p1", "sk-h1");
    expect(def?.execute).toBe(exec);
    expect(def?.description).toBe("from store");
  });

  it("define without execute registers declarative skill", async () => {
    const persisted: SkillDefinitionPersisted = { id: "sk-h2", tools: [] };
    await Skill.define(persisted);
    expect(getSkillDefinition("any", "sk-h2")).toMatchObject({ id: "sk-h2", tools: [] });

    clearAllRegistriesForTests();
    await Skill.define(persisted, async () => "x");
    expect(getSkillDefinition("any", "sk-h2")?.execute).toBeDefined();
  });

  it("defineBatch maps executes by id", async () => {
    const items: SkillDefinitionPersisted[] = [
      { id: "a", tools: [] },
      { id: "b", tools: [] },
    ];
    const execA = async () => 1;
    await Skill.defineBatch(items, { a: execA });
    expect(getSkillDefinition("x", "a")?.execute).toBe(execA);
    expect(getSkillDefinition("x", "b")?.execute).toBeUndefined();
  });

  it("defineBatch ignores executes[id] when item already has execute", async () => {
    const inline = async () => "inline";
    const fromMap = async () => "map";
    await Skill.defineBatch([{ id: "c", tools: [], execute: inline }], { c: fromMap });
    expect(getSkillDefinition("x", "c")?.execute).toBe(inline);
  });

  it("define with inline execute ignores second argument", async () => {
    const e1 = async () => 1;
    const e2 = async () => 2;
    await Skill.define({ id: "ov", tools: [], execute: e1 }, e2);
    expect(getSkillDefinition("any", "ov")?.execute).toBe(e1);
  });
});
