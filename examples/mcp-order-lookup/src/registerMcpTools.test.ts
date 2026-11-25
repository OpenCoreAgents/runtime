import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolveToolRegistry, type ToolContext } from "@opencoreagents/core";
import { mcpToolId, registerMcpTools } from "./registerMcpTools.js";

test("isolates handlers and imports all pages when using the wildcard", async (t) => {
  async function connect(label: string) {
    const server = new Server({ name: label, version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
      const name = params?.cursor === "next" ? "estimate_delivery" : "lookup_order";
      return {
        tools: [{ name, inputSchema: { type: "object" } }],
        ...(name === "lookup_order" ? { nextCursor: "next" } : {}),
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
      content: [{ type: "text", text: `${label}:${params.name}` }],
    }));

    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    t.after(async () => {
      await client.close();
      await server.close();
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  const first = await connect("first");
  const second = await connect("second");
  const [firstTool, secondPageTool] = await registerMcpTools(first, "project-a", "orders", "*");
  const [secondTool] = await registerMcpTools(second, "project-b", "orders", ["lookup_order"]);
  assert.notEqual(firstTool, secondTool);
  assert.equal(secondPageTool, mcpToolId("project-a", "orders", "estimate_delivery"));
  await assert.rejects(
    registerMcpTools(second, "project-a", "orders", ["lookup_order"]),
    /already registered/,
  );

  for (const [id, label, name] of [
    [firstTool, "first", "lookup_order"],
    [secondPageTool, "first", "estimate_delivery"],
    [secondTool, "second", "lookup_order"],
  ]) {
    const handler = resolveToolRegistry("project-a").get(id);
    assert.ok(handler);
    // The MCP bridge does not use the Core tool context for this call.
    assert.deepEqual(await handler.execute({}, {} as ToolContext), [
      { type: "text", text: `${label}:${name}` },
    ]);
  }
});
