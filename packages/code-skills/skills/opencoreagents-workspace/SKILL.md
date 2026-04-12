---
name: opencoreagents-workspace
description: Navigate the OpenCore Agents monorepo (@opencoreagents/*), pnpm workspaces, Turbo, docs layout, and where to change code safely.
---

# OpenCore Agents — monorepo workspace

> **Bundled docs:** **`docs/`** next to this file (same layout as monorepo `docs/`: `core/`, `planning/`, top-level guides). **`packages/`** next to `docs/` holds README stubs so `../../packages/...` links from copied `core/*.md` still resolve. From code: `skillDocsDirectory("opencoreagents-workspace")` → `docs/`; sibling `packages/` is under the same skill folder. Run `pnpm build` in `@opencoreagents/code-skills` to materialize both when working from a clone.

Use this skill when editing or explaining this repository’s **layout**, **build**, or **documentation**—not when you only need one API snippet (use **opencoreagents-engine** or the focused skills).

## Facts

- **Public runtime repository:** [OpenCoreAgents/runtime](https://github.com/OpenCoreAgents/runtime) — upstream source, issues, and releases for the `@opencoreagents/*` packages.
- **Package scope:** `@opencoreagents/*` under `packages/*`. **Examples** live under `examples/*` (workspace members, not published like library packages).
- **Install / CI:** `pnpm install`, then `pnpm turbo run build test lint` from repo root.
- **Canonical engine docs:** `docs/core/README.md` (index of all core topics).
- **Planning / roadmap:** `docs/planning/README.md`, `docs/planning/plan.md`. **`technical-debt.md` is not bundled** in this pack (it goes stale in old skill installs)—use the live [OpenCoreAgents/runtime](https://github.com/OpenCoreAgents/runtime) tree on `main` for the current gap list.
- **Runnable demos:** only in a full clone — `examples/README.md` (not shipped inside this skill pack).

## Before risky changes

- **Security / tenancy / REST hardening:** read `docs/core/08-scope-and-security.md` and the latest planning docs on [OpenCoreAgents/runtime](https://github.com/OpenCoreAgents/runtime) `main` before telling the user a feature is “production ready.”
- **REST route contract:** `docs/planning/plan-rest.md` + `packages/rest-api/README.md`.

## Package map (short)

| Area | Packages |
|------|-----------|
| Engine | `core` |
| LLM | `adapters-openai`, `adapters-anthropic` |
| Redis / queue | `adapters-redis`, `adapters-upstash`, `adapters-bullmq` |
| HTTP tools + dynamic defs | `adapters-http-tool`, `dynamic-definitions` |
| REST router | `rest-api` |
| RAG | `rag`, `utils` |
| CLI / codegen | `cli`, `scaffold` |
| Gateway | `conversation-gateway` |

## Commands (examples)

```bash
pnpm turbo run build --filter=@opencoreagents/core
pnpm turbo run test --filter=@opencoreagents/rest-api
```

Do **not** invent package names; grep `packages/*/package.json` for `"name"` if unsure.
