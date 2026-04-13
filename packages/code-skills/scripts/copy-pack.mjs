import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pkgRoot, "..", "..");
const dist = join(pkgRoot, "dist");

/**
 * Per-skill layout (mirrors monorepo link targets from `docs/core/*.md`):
 *   skills/<id>/docs/     — core/, planning/, optional top-level guides
 *   skills/<id>/packages/ — README.md subset (sibling of docs/ so ../../packages/... works)
 */
const bundles = {
  "opencoreagents-workspace": {
    dirs: [
      ["docs/core", "core"],
      ["docs/planning", "planning"],
    ],
    rootFiles: ["README.md", "getting-started.md"].map((n) => join("docs", n)),
    packageReadmes: ["core/README.md", "rest-api/README.md", "rag/README.md"],
  },
  "opencoreagents-engine": {
    coreFiles: [
      "README.md",
      "01-purpose.md",
      "02-architecture.md",
      "03-execution-model.md",
      "04-protocol.md",
      "05-adapters-contracts.md",
      "06-adapters-infrastructure.md",
      "07-definition-syntax.md",
      "08-scope-and-security.md",
      "09-communication-multiagent.md",
      "10-llm-adapter.md",
      "11-context-builder.md",
      "12-skills.md",
      "13-errors-parsing-and-recovery.md",
      "19-cluster-deployment.md",
    ],
    planningFiles: ["mvp.md"],
    packageReadmes: ["core/README.md"],
  },
  "opencoreagents-rest-workers": {
    coreFiles: ["15-multi-tenancy.md", "21-dynamic-runtime-rest.md"],
    packageReadmes: ["rest-api/README.md", "core/README.md"],
  },
  "opencoreagents-rag-dynamic": {
    coreFiles: ["17-rag-pipeline.md", "07-definition-syntax.md"],
    packageReadmes: ["rag/README.md", "core/README.md"],
  },
};

function rmIfExists(p) {
  if (existsSync(p)) rmSync(p, { recursive: true });
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function copyRepoFile(srcRel, destAbs) {
  const from = join(repoRoot, ...srcRel.split("/").filter(Boolean));
  if (!existsSync(from)) {
    throw new Error(`copy-pack: missing ${from}`);
  }
  ensureDir(dirname(destAbs));
  cpSync(from, destAbs);
}

function populateDocsFolder(destDocs, spec) {
  rmIfExists(destDocs);
  ensureDir(destDocs);

  if (spec.dirs) {
    for (const [src, dst] of spec.dirs) {
      const from = join(repoRoot, ...src.split("/"));
      if (!existsSync(from)) {
        throw new Error(`copy-pack: missing ${from}`);
      }
      cpSync(from, join(destDocs, dst), { recursive: true });
    }
  }

  if (spec.rootFiles) {
    for (const src of spec.rootFiles) {
      const parts = src.split("/");
      const name = parts[parts.length - 1];
      copyRepoFile(src, join(destDocs, name));
    }
  }

  if (spec.coreFiles) {
    for (const f of spec.coreFiles) {
      copyRepoFile(`docs/core/${f}`, join(destDocs, "core", f));
    }
  }

  if (spec.planningFiles) {
    for (const f of spec.planningFiles) {
      copyRepoFile(`docs/planning/${f}`, join(destDocs, "planning", f));
    }
  }
}

function populateSkill(skillId, spec) {
  const skillRoot = join(pkgRoot, "skills", skillId);
  populateDocsFolder(join(skillRoot, "docs"), spec);

  // Omit stale snapshots: technical-debt changes often: see live repo, not an old skill tarball.
  if (skillId === "opencoreagents-workspace") {
    rmIfExists(join(skillRoot, "docs", "planning", "technical-debt.md"));
  }

  const destPkgs = join(skillRoot, "packages");
  rmIfExists(destPkgs);
  if (spec.packageReadmes?.length) {
    for (const rel of spec.packageReadmes) {
      copyRepoFile(`packages/${rel}`, join(destPkgs, rel));
    }
  }
}

if (!existsSync(dist)) {
  ensureDir(dist);
}

// Older layouts wrote flat dist/docs + dist/packages; remove so publishes stay per-skill only.
rmIfExists(join(dist, "docs"));
rmIfExists(join(dist, "packages"));

for (const skillId of Object.keys(bundles)) {
  populateSkill(skillId, bundles[skillId]);
}

const destSkills = join(dist, "skills");
rmIfExists(destSkills);
cpSync(join(pkgRoot, "skills"), destSkills, { recursive: true });
