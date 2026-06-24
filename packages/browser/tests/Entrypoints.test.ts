import { describe, expect, it } from "vitest";
import * as browser from "../src/index.js";
import * as webllm from "../src/webllm.js";

describe("browser package entrypoints", () => {
  it("keeps persistence in the model-runtime-independent main entry", () => {
    expect(browser).toHaveProperty("IndexedDBMemoryAdapter");
    expect(browser).toHaveProperty("IndexedDBRunStore");
    expect(browser).toHaveProperty("IndexedDBDynamicDefinitionsStore");
    expect(browser).not.toHaveProperty("WebLLMAdapter");
  });

  it("exposes WebLLM only through its optional integration entry", () => {
    expect(webllm).toHaveProperty("WebLLMAdapter");
    expect(webllm).toHaveProperty("createWebLLMWorkerEngineFactory");
  });
});
