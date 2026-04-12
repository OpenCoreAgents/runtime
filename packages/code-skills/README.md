# `@opencoreagents/code-skills`

**Agent-oriented skill packs** for coding assistants (Cursor, Claude Code, Codex, etc.): each folder under `skills/<id>/` contains a **`SKILL.md`** with YAML frontmatter (`name`, `description`) plus instructions grounded in this monorepo’s real packages and docs.

This package does **not** register engine `Skill.define` entries at runtime—it ships **documentation** for humans and for tools that load skill markdown.

## Layout

| Skill id | Use when |
|----------|-----------|
| `opencoreagents-workspace` | Repo map, Turbo/pnpm, where docs live |
| `opencoreagents-engine` | `@opencoreagents/core`, adapters, run loop |
| `opencoreagents-rest-workers` | `rest-api`, BullMQ, dynamic-runtime patterns |
| `opencoreagents-rag-dynamic` | `@opencoreagents/rag`, catalogs, file/vector tools |

Each skill folder is self-contained after **`pnpm build`**:

- **`docs/`** — markdown copied from monorepo `docs/` (per-skill subset, or full `core/` + `planning/` for the workspace skill).
- **`packages/`** — sibling folder with a small set of `packages/*/README.md` files so links like `../../packages/rest-api/README.md` from bundled `core/*.md` still work.

Generated `docs/` and `packages/` are **gitignored**; `scripts/copy-pack.mjs` fills them before copying `skills/` → `dist/skills/` for publish.

## Use in Cursor / Claude / Codex

1. **From a clone:** point at `packages/code-skills/skills/<id>/` (run **`pnpm build --filter=@opencoreagents/code-skills`** so `docs/` and `packages/` exist), or use the published tarball under `node_modules/.../dist/skills/<id>/`.

2. **From npm / GitHub Packages:** everything ships under **`dist/skills/<id>/`** (`SKILL.md`, `docs/`, `packages/`).

## API

```typescript
import {
  skillsDirectory,
  skillIds,
  skillDocsDirectory,
  skillPackagesDirectory,
} from "@opencoreagents/code-skills";

skillDocsDirectory("opencoreagents-engine"); // …/skills/opencoreagents-engine/docs
skillPackagesDirectory("opencoreagents-engine"); // …/skills/opencoreagents-engine/packages
```

## Build

`pnpm build` runs `tsup` then `node ./scripts/copy-pack.mjs`, which hydrates each skill’s **`docs/`** and **`packages/`**, then copies the full **`skills/`** tree into **`dist/skills/`**.

## Clean

`pnpm clean` removes **`dist/`** and generated **`skills/*/docs/`** and **`skills/*/packages/`**.
