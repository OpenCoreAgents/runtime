import { describe, it, expect } from "vitest";
import { splitExecCommandLine } from "../src/execTool.js";

describe("splitExecCommandLine", () => {
  it("splits on whitespace", () => {
    expect(splitExecCommandLine("node -p 42")).toEqual(["node", "-p", "42"]);
  });

  it("respects double-quoted segments", () => {
    expect(splitExecCommandLine('git commit -m "hello world"')).toEqual([
      "git",
      "commit",
      "-m",
      "hello world",
    ]);
  });

  it("respects single-quoted segments", () => {
    expect(splitExecCommandLine("run '/tmp/a b/c'")).toEqual(["run", "/tmp/a b/c"]);
  });

  it("trims nothing inside quotes and collapses outer spaces", () => {
    expect(splitExecCommandLine('  echo  "a b"  ')).toEqual(["echo", "a b"]);
  });
});
