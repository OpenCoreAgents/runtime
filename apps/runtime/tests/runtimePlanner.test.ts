import { describe, expect, it } from "vitest";
import { resolvePlannerSubAgentProvider } from "../src/runtime/runtimePlanner.js";
import type { ResolvedLlmStackConfig } from "../src/config/types.js";

function llm(partial: Partial<ResolvedLlmStackConfig>): ResolvedLlmStackConfig {
  return {
    defaultProvider: partial.defaultProvider ?? "openai",
    openai: { apiKey: "", baseUrl: "", ...partial.openai },
    anthropic: { apiKey: "", baseUrl: "", ...partial.anthropic },
  };
}

describe("resolvePlannerSubAgentProvider", () => {
  it("returns preferred when that provider has an API key", () => {
    const cfg = llm({
      defaultProvider: "openai",
      openai: { apiKey: "sk-openai", baseUrl: "" },
      anthropic: { apiKey: "", baseUrl: "" },
    });
    expect(resolvePlannerSubAgentProvider(cfg, "anthropic")).toBe("openai");
    const both = llm({
      defaultProvider: "openai",
      openai: { apiKey: "a", baseUrl: "" },
      anthropic: { apiKey: "b", baseUrl: "" },
    });
    expect(resolvePlannerSubAgentProvider(both, "anthropic")).toBe("anthropic");
  });

  it("falls back to defaultProvider when preferred has no key", () => {
    const cfg = llm({
      defaultProvider: "anthropic",
      openai: { apiKey: "", baseUrl: "" },
      anthropic: { apiKey: "k", baseUrl: "" },
    });
    expect(resolvePlannerSubAgentProvider(cfg, "openai")).toBe("anthropic");
  });

  it("picks any keyed provider when default has no key", () => {
    const onlyAnthropic = llm({
      defaultProvider: "openai",
      openai: { apiKey: "", baseUrl: "" },
      anthropic: { apiKey: "x", baseUrl: "" },
    });
    expect(resolvePlannerSubAgentProvider(onlyAnthropic)).toBe("anthropic");

    const onlyOpenai = llm({
      defaultProvider: "anthropic",
      openai: { apiKey: "y", baseUrl: "" },
      anthropic: { apiKey: "", baseUrl: "" },
    });
    expect(resolvePlannerSubAgentProvider(onlyOpenai)).toBe("openai");
  });

  it("returns defaultProvider when no keys are set", () => {
    const cfg = llm({
      defaultProvider: "anthropic",
      openai: { apiKey: "  ", baseUrl: "" },
      anthropic: { apiKey: "", baseUrl: "" },
    });
    expect(resolvePlannerSubAgentProvider(cfg)).toBe("anthropic");
  });
});
