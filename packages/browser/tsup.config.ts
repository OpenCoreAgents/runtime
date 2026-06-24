import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/webllm.ts", "src/webllm-worker.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  platform: "browser",
  target: "es2022",
});
