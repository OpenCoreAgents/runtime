# `@opencoreagents/adapters-http-tool`

Registers **`ToolAdapter`** instances from **JSON-serializable** HTTP configuration (URL, method, headers, query/body templates) so outbound integrations do not need a per-tool `execute` in TypeScript.

## Documentation

Full reference: [`docs/core/20-http-tool-adapter.md`](../../docs/core/20-http-tool-adapter.md).

## Quick use

```typescript
import { registerHttpToolsFromDefinitions } from "@opencoreagents/adapters-http-tool";

await registerHttpToolsFromDefinitions(catalogFromJson, {
  secrets: { API_KEY: process.env.API_KEY! },
});
```

## Exports

- **`registerHttpToolsFromDefinitions`** — `Tool.define` (schema only) + `registerToolHandler` per entry
- **`createHttpToolAdapter`** — single adapter for manual registration
- **`resolveTemplate`**, **`resolveAllowedHostnames`**, **`assertUrlHostAllowed`** — building blocks
