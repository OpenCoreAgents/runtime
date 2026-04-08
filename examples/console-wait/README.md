# Console wait (`onWait` + stdin)

Demonstrates **`RunBuilder.onWait`**: the model returns a **`wait`** step; the callback **reads a line from the terminal** and returns it so the run **continues in-process** (no `runStore`, no `resume` API).

The LLM is a **small mock** (no API keys): turn 1 → `wait`, turn 2 → `result` echoing what you typed.

**Production:** this demo uses **`InMemoryMemoryAdapter`** (single process only). For real deployments use **Redis** / **Upstash** memory adapters — see [`examples/README.md`](../README.md#memory-in-production).

## Prerequisite

```bash
pnpm turbo run build --filter=@agent-runtime/core
```

## Run

```bash
pnpm --filter @agent-runtime/example-console-wait start
```

You should see a pause, a prompt (`Type a line and press Enter…`), then a final **result** line that quotes your input.

## Relation to production

- Same process: **`onWait` returns `string`** → engine injects `[resume:text] …` and continues.
- **Cluster / another machine**: return **`undefined`** from `onWait`, persist with **`runStore`**, and call **`Agent.resume`** when the user answers (see [`docs/core/19-cluster-deployment.md`](../../docs/core/19-cluster-deployment.md)).
