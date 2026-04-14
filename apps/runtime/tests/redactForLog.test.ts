import { describe, expect, it } from "vitest";
import { redactRedisUrlForLog } from "../src/util/redactForLog.js";

describe("redactRedisUrlForLog", () => {
  it("redacts username and password in redis URL", () => {
    expect(redactRedisUrlForLog("redis://user:secret@127.0.0.1:6379/0")).toBe(
      "redis://***:***@127.0.0.1:6379/0",
    );
  });

  it("returns placeholder for invalid URL", () => {
    expect(redactRedisUrlForLog("not-a-url")).toBe("<invalid-redis-url>");
  });

  it("leaves URL without credentials unchanged (aside from normalization)", () => {
    const out = redactRedisUrlForLog("redis://127.0.0.1:6379");
    expect(out).not.toContain("***");
    expect(out).toContain("127.0.0.1");
  });
});
