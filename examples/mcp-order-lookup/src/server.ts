import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "demo-orders", version: "1.0.0" });

server.registerTool(
  "lookup_order",
  {
    description: "Look up a fictional order by ID.",
    inputSchema: { orderId: z.string().min(1) },
  },
  async ({ orderId }) => {
    if (orderId !== "ORD-42") {
      return {
        isError: true,
        content: [{ type: "text", text: `Order ${orderId} was not found.` }],
      };
    }

    return {
      content: [{ type: "text", text: "Order ORD-42 is in transit." }],
    };
  },
);

server.registerTool(
  "estimate_delivery",
  {
    description: "Estimate delivery for a fictional order.",
    inputSchema: { orderId: z.string().min(1) },
  },
  async ({ orderId }) => ({
    isError: orderId !== "ORD-42",
    content: [
      {
        type: "text",
        text:
          orderId === "ORD-42"
            ? "Order ORD-42 is expected in two business days."
            : `Order ${orderId} was not found.`,
      },
    ],
  }),
);

server.registerTool(
  "internal_notes",
  { description: "Return fictional internal notes." },
  async () => ({
    content: [{ type: "text", text: "Internal demo notes." }],
  }),
);

await server.connect(new StdioServerTransport());
