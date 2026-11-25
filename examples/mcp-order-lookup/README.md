# Connect selected MCP tools to OpenCore

This example starts a local MCP server over stdio, discovers its tools, and gives an OpenCore agent access to two selected tools. It uses a scripted model and fictional orders.

## Run from the repository root

```bash
pnpm install
pnpm turbo run build --filter=@opencoreagents/core
pnpm --filter @opencoreagents/example-mcp-order-lookup start
pnpm --filter @opencoreagents/example-mcp-order-lookup start ORD-42 estimate_delivery
```

The first run reports that order `ORD-42` is in transit. The second reports the delivery estimate.

## Select which tools an agent can use

The application connects the client, chooses the allowed MCP tool names, and assigns the returned Core tool IDs to the agent definition:

```ts
const toolIds = await registerMcpTools(client, projectId, "orders", [
  "lookup_order",
  "estimate_delivery",
]);

// Set tools: toolIds in Agent.define().
```

[`registerMcpTools.ts`](src/registerMcpTools.ts) discovers the tool schemas with `listTools()`, registers the selected tools in the given project, and forwards each call through `client.callTool()`. The demo server also advertises `internal_notes`, which the application leaves out of the agent's tool list. Core tool IDs are derived from the project ID, connection namespace, and remote tool name. Use a distinct namespace for each MCP connection in a project. If an ID is already registered in the process, the helper rejects the registration before adding any tools.

Pass `"*"` (or `["*"]`) to register every tool in the connected server's catalog. This includes tools on later pages. Choose this option only when the agent should have access to the entire catalog.

```ts
const toolIds = await registerMcpTools(client, projectId, "orders", "*");
```

To try wildcard registration against the demo server:

```bash
pnpm --filter @opencoreagents/example-mcp-order-lookup start ORD-42 internal_notes --all
```

The application controls the server connection, the allowlist, and the agent's permissions. The [client](src/main.ts) closes the transport when execution ends. The [server](src/server.ts) validates tool arguments and returns MCP tool results.

See the [MCP TypeScript client docs](https://ts.sdk.modelcontextprotocol.io/client) for connection options.
