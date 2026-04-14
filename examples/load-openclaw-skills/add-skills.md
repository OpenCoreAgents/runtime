# Where to get skills and how to install them

Companion guide for the [load-openclaw-skills example](./README.md). This example loads from **`./skills`** under this package: `examples/load-openclaw-skills/skills/<skill-folder>/SKILL.md`.

A skill is a **directory** that contains **`SKILL.md`** (YAML frontmatter + markdown body, OpenClaw / AgentSkills style).

---

## Option A — OpenClaw CLI (if you use OpenClaw)

From an OpenClaw workspace, native commands install into the workspace **`skills/`** directory (see [ClawHub — OpenClaw docs](https://docs.openclaw.ai/clawhub)):

```bash
openclaw skills search "calendar"
openclaw skills install <skill-slug>
openclaw skills update --all
```

To feed **this** repo example, either point **`loadOpenClawSkills({ dirs: [...] })`** at that workspace’s `skills` path, or copy/symlink installed folders into **`examples/load-openclaw-skills/skills/`**.

---

## Option B — `runtime` (OpenCoreAgents CLI, no OpenClaw required)

With this monorepo and **`@opencoreagents/cli`** (the **`runtime`** binary), you can install a skill from ClawHub over HTTP (same API as the official `clawhub` CLI):

```bash
# From a project root that has ./skills (or pass --cwd / --skills-dir)
pnpm exec runtime skills install <skill-slug> --cwd .

# Overwrite an existing folder / accept a “suspicious” skill without an interactive prompt
pnpm exec runtime skills install <skill-slug> --cwd . --force

# Optional explicit registry or version
pnpm exec runtime skills install <skill-slug> --registry https://clawhub.ai --version 1.2.3
```

Useful environment variables: **`CLAWHUB_REGISTRY`**, **`CLAWHUB_TOKEN`** (private skills). See **`runtime --help`**.

---

## Option C — ClawHub CLI (`clawhub`)

Install the CLI (publish/auth workflows; also installs skills locally):

```bash
npm i -g clawhub
# or: pnpm add -g clawhub
```

From the **example package directory** (so files land next to this demo):

```bash
cd examples/load-openclaw-skills
clawhub search "summarize"
clawhub install <skill-slug>
```

By default, skills go under **`./skills`** relative to the workdir (override with **`--dir`** / **`CLAWHUB_WORKDIR`** — see [ClawHub docs](https://docs.openclaw.ai/clawhub)). After installing, run **`pnpm start`** again so **`loadOpenClawSkills`** picks up the new folder.

---

## Option D — Git or zip (manual)

1. **Git:** clone a repo that ships a skill layout OpenClaw-style (one folder per skill, each with **`SKILL.md`**):

   ```bash
   cd examples/load-openclaw-skills/skills
   git clone --depth 1 https://github.com/<org>/<repo>.git my_skill_vendor
   # Ensure SKILL.md exists at: skills/my_skill_vendor/SKILL.md
   # (Some repos nest skills; adjust path or copy the skill folder here.)
   ```

2. **Zip:** on [clawhub.ai](https://clawhub.ai/), open a skill → download the bundle → extract so **`SKILL.md`** ends up at **`skills/<folder-name>/SKILL.md`**.

3. **Hand-written:** copy an existing **`SKILL.md`** into **`skills/<id>/SKILL.md`** and set **`name`** / **`description`** in frontmatter.

---

## After installing

- Skills with **`metadata.openclaw.requires.bins`** (or **`env`**, **`config`**) may **not** load until those requirements are satisfied — the example logs **`skipped`** with a reason.
- Skills that mention tools you did **not** register (browser, HTTP, etc.) will still **load** as prompt text, but the model cannot call missing tools unless you add matching **`Tool.define`** entries and allowlist them on the agent.

---

## Recommended skills (where to start)

There is no fixed “best” list: ClawHub is large and changes often. Browse and search on **[clawhub.ai](https://clawhub.ai/)** or use **`clawhub search`** / **`openclaw skills search`**.

**Good fit for *this* example** (minimal integration):

- Skills whose instructions mostly use **shell / CLI** via **`exec`** (same pattern as **`openclaw_demo`**).
- Skills that do **not** require extra binaries you have not installed, or they will be **skipped** at load time.

**Useful search themes** (plug into `clawhub search "…"` or the site search):

| Theme | Example queries | Notes |
|--------|------------------|--------|
| Text / files | `summarize`, `markdown`, `pdf extract` | Often need `python`, `pandoc`, or similar — install or expect **skipped** gates. |
| Dev tooling | `git`, `github`, `diff` | Usually need **`git`** on **`PATH`**. |
| Media | `ffmpeg`, `audio`, `video` | Needs **`ffmpeg`** if the skill gates on it. |
| Data | `sqlite`, `csv`, `json` | May use **`sqlite3`** or **`node`** / **`python`**. |
| Productivity | `calendar`, `reminder`, `notes` | May assume OpenClaw-only tools; read **`SKILL.md`** before relying on it here. |

**Safety:** ClawHub is community-sourced. **Read `SKILL.md` before use**, prefer starred / established authors when possible, and treat **`exec`** as **arbitrary process execution** inside your sandbox. Official overview: [ClawHub — OpenClaw docs](https://docs.openclaw.ai/clawhub).
