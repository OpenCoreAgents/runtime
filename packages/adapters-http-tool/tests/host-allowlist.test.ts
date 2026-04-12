import { describe, expect, it } from "vitest";
import { assertUrlHostAllowed, resolveAllowedHostnames } from "../src/hostAllowlist.js";

describe("resolveAllowedHostnames", () => {
  it("defaults to the URL hostname when explicit is empty", () => {
    expect(resolveAllowedHostnames("https://crm.example.com/path", undefined)).toEqual([
      "crm.example.com",
    ]);
    expect(resolveAllowedHostnames("https://crm.example.com/path", [])).toEqual([
      "crm.example.com",
    ]);
  });

  it("uses explicit list when non-empty", () => {
    expect(
      resolveAllowedHostnames("https://crm.example.com/path", ["crm.example.com", "other.com"]),
    ).toEqual(["crm.example.com", "other.com"]);
  });
});

describe("assertUrlHostAllowed", () => {
  it("allows when default host matches", () => {
    expect(() =>
      assertUrlHostAllowed("https://crm.example.com/v1", undefined),
    ).not.toThrow();
  });

  it("rejects when explicit list omits URL host", () => {
    expect(() =>
      assertUrlHostAllowed("https://evil.com/x", ["crm.example.com"]),
    ).toThrow(/not allowed/);
  });

  it("allows when explicit list includes URL host", () => {
    expect(() =>
      assertUrlHostAllowed("https://crm.example.com/x", ["crm.example.com"]),
    ).not.toThrow();
  });
});
