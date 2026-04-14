---
name: openclaw_demo
description: Demonstrates the OpenClaw skill loader — uses the exec tool with Node (same runtime as pnpm start).
---

# OpenClaw demo skill

When the user asks you to run the OpenClaw demo:

1. Use the **`exec`** tool with command **`node -p 42`** (prints `42` to stdout).
2. In your final **`result`**, include the numeric stdout from the observation so we can see the skill + tool path worked.

The placeholder `{baseDir}` resolves to this skill’s directory on disk: `{baseDir}`.
