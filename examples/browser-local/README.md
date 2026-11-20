# Browser-Local Runtime Example

This Vite application runs `@opencoreagents/core` entirely in a browser tab. Its primary path uses a deterministic adapter to demonstrate the runtime and persistence without a server or model download. It offers two modes:

- A deterministic adapter that requires no server, API key, model download, or network request.
- An optional WebLLM adapter that downloads model assets once and performs inference locally through WebGPU.

WebLLM inference runs in a module worker so model execution does not block the UI thread.
Agent memory and run history use IndexedDB and survive page reloads. The demo includes a user-controlled action that deletes its local agent database.
The agent definition is also stored in IndexedDB and hydrated into `core` through `runtime.dispatch()` before each run.

## Run

Build the core package and start the example:

```bash
pnpm turbo run build --filter=@opencoreagents/core --filter=@opencoreagents/browser
pnpm --filter @opencoreagents/example-browser-local dev
```

Then open the URL printed by Vite.

## Verify the Production Bundle

```bash
pnpm --filter @opencoreagents/example-browser-local build
```

The example resolves the `browser` export from `@opencoreagents/core`. The generated application bundle must not require Node.js polyfills.

The default WebLLM selection is a small model intended to make the proof of concept accessible. Model quality and structured output reliability vary; larger instruction models generally behave better but require more memory and a larger initial download.
