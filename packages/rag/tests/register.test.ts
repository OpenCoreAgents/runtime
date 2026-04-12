import { describe, it, beforeEach, expect } from "vitest";
import { registerRagToolsAndSkills } from "../src/register.js";
import { __resetRagFileCatalogForTests } from "../src/catalog.js";
import { clearAllRegistriesForTests } from "@opencoreagents/core";
import { RAG_SYSTEM_TOOL_IDS, isRagSystemToolId } from "../src/systemToolIds.js";

describe("registerRagToolsAndSkills", () => {
  beforeEach(() => {
    clearAllRegistriesForTests();
    __resetRagFileCatalogForTests();
  });

  it("registers without error", async () => {
    await expect(registerRagToolsAndSkills()).resolves.toBeUndefined();
  });

  it("is idempotent for same process", async () => {
    await registerRagToolsAndSkills();
    await expect(registerRagToolsAndSkills()).resolves.toBeUndefined();
  });

  it("RAG_SYSTEM_TOOL_IDS matches package tool ids", () => {
    expect(RAG_SYSTEM_TOOL_IDS.length).toBe(5);
    expect(isRagSystemToolId("system_file_read")).toBe(true);
    expect(isRagSystemToolId("system_save_memory")).toBe(false);
  });
});
