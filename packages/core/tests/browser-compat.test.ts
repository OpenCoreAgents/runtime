import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "tsup";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("browser compatibility", () => {
  it("bundles the complete core entrypoint without Node.js polyfills", async () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const outDir = await mkdtemp(path.join(tmpdir(), "opencoreagents-core-browser-"));
    temporaryDirectories.push(outDir);

    await build({
      entry: [path.join(packageRoot, "src/index.ts")],
      format: ["esm"],
      platform: "browser",
      target: "es2022",
      outDir,
      clean: false,
      dts: false,
      minify: false,
      silent: true,
    });

    const bundle = await readFile(path.join(outDir, "index.js"), "utf8");
    expect(bundle).not.toContain('from "node:');
    expect(bundle).not.toContain("process.env");
    expect(bundle).not.toContain("@opencoreagents/dynamic-definitions");
  });
});
