import { describe, expect, it } from "vitest";
import { createRun } from "../src/engine/Engine.js";

describe("runtime environment portability", () => {
  it("creates RFC 4122 version 4 run IDs through Web Crypto", () => {
    const run = createRun("agent", "session", "hello");

    expect(run.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("continues to honor explicit run IDs", () => {
    const run = createRun("agent", "session", "hello", "project", " explicit-id ");

    expect(run.runId).toBe("explicit-id");
  });
});
