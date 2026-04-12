import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  platform: "node",
  target: "node18",
  /** Dynamic `import()` only when `dynamicDefinitionsStore` is set; must not be bundled into core. */
  external: ["@opencoreagents/dynamic-definitions"],
});
