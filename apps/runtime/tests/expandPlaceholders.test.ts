import { afterEach, describe, expect, it, vi } from "vitest";
import { expandDeep, expandEnvPlaceholders } from "../src/config/expandPlaceholders.js";

describe("expandEnvPlaceholders", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("substitutes ${VAR} from process.env", () => {
    vi.stubEnv("RUNTIME_TEST_FOO", "hello");
    expect(expandEnvPlaceholders("x=${RUNTIME_TEST_FOO}y")).toBe("x=helloy");
  });

  it("uses :- default when env missing or empty", () => {
    vi.stubEnv("RUNTIME_TEST_MISSING", "");
    expect(expandEnvPlaceholders("${RUNTIME_TEST_MISSING:-fallback}")).toBe("fallback");
    expect(expandEnvPlaceholders("${RUNTIME_TEST_ABSENT:-z}")).toBe("z");
  });

  it("leaves string unchanged when there are no placeholders", () => {
    expect(expandEnvPlaceholders("plain / no braces")).toBe("plain / no braces");
  });
});

describe("expandDeep", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("recurses objects and arrays", () => {
    vi.stubEnv("RUNTIME_TEST_PORT", "3010");
    const input = {
      server: { port: "${RUNTIME_TEST_PORT}" },
      tags: ["${RUNTIME_TEST_PORT}"],
    };
    expect(expandDeep(input)).toEqual({
      server: { port: "3010" },
      tags: ["3010"],
    });
  });

  it("leaves non-string leaves unchanged", () => {
    expect(expandDeep({ n: 42, f: false })).toEqual({ n: 42, f: false });
  });
});
