import { describe, it, expect } from "vitest";
import {
  CORE_SYSTEM_TOOL_IDS,
  isCoreSystemToolId,
} from "../src/tools/systemToolIds.js";

describe("systemToolIds", () => {
  it("CORE_SYSTEM_TOOL_IDS lists core engine system_* ids", () => {
    expect(CORE_SYSTEM_TOOL_IDS).toContain("system_save_memory");
    expect(CORE_SYSTEM_TOOL_IDS).toContain("system_send_message");
    expect(CORE_SYSTEM_TOOL_IDS.length).toBe(6);
  });

  it("isCoreSystemToolId matches known ids only", () => {
    expect(isCoreSystemToolId("system_vector_search")).toBe(true);
    expect(isCoreSystemToolId("system_list_rag_sources")).toBe(false);
    expect(isCoreSystemToolId("lookup_ticket")).toBe(false);
  });
});
