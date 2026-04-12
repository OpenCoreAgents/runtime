import { describe, expect, it } from "vitest";
import type { ToolContext } from "@opencoreagents/core";
import { InMemoryMemoryAdapter } from "@opencoreagents/core";
import { resolveTemplate } from "../src/template.js";

const ctx = (): ToolContext => ({
  projectId: "p1",
  agentId: "a1",
  runId: "r1",
  sessionId: "s1",
  memoryAdapter: new InMemoryMemoryAdapter(),
  securityContext: {
    principalId: "x",
    kind: "internal",
    organizationId: "o1",
    projectId: "p1",
    roles: ["agent"],
    scopes: ["*"],
  },
});

describe("resolveTemplate", () => {
  it("resolves input and context", () => {
    const out = resolveTemplate("{{input.email}}|{{context.runId}}", { email: "a@b.co" }, ctx(), {});
    expect(out).toBe("a@b.co|r1");
  });

  it("resolves secrets", () => {
    const out = resolveTemplate("Bearer {{secret:K}}", {}, ctx(), { K: "tok" });
    expect(out).toBe("Bearer tok");
  });

  it("throws on missing secret", () => {
    expect(() => resolveTemplate("{{secret:MISSING}}", {}, ctx(), {})).toThrow(/Missing secret/);
  });
});
