import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const skillsRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

for (const id of readdirSync(skillsRoot)) {
  for (const name of ["docs", "packages"]) {
    const p = join(skillsRoot, id, name);
    if (existsSync(p)) {
      rmSync(p, { recursive: true });
    }
  }
}
