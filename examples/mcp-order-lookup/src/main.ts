import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  Agent,
  AgentRuntime,
  InMemoryMemoryAdapter,
  Session,
  type LLMAdapter,
} from "@opencoreagents/core";
import { mcpToolId, registerMcpTools } from "./registerMcpTools.js";

const projectId = "demo-mcp";
const connectionNamespace = "orders";
const allowedTools = ["lookup_order", "estimate_delivery"] as const;
const requestedTool = process.argv[3] ?? "lookup_order";
const orderId = process.argv[2] ?? "ORD-42";

const client = new Client({ name: "opencore-order-demo", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    "--import",
    import.meta.resolve("tsx"),
    fileURLToPath(new URL("./server.ts", import.meta.url)),
  ],
});

try {
  await client.connect(transport);

  const toolIds = await registerMcpTools(
    client,
    projectId,
    connectionNamespace,
    process.argv[4] === "--all" ? "*" : allowedTools,
  );
  const toolId = mcpToolId(projectId, connectionNamespace, requestedTool);
  if (!toolIds.includes(toolId)) {
    throw new Error(`Choose an allowed MCP tool: ${allowedTools.join(", ")}.`);
  }

  const llmAdapter: LLMAdapter = {
    async generate({ messages }) {
      const observation = messages.at(-1)?.content;
      if (!observation?.startsWith("Observation: ")) {
        return { content: JSON.stringify({ type: "action", tool: toolId, input: { orderId } }) };
      }

      const result: unknown = JSON.parse(observation.slice("Observation: ".length));
      if (typeof result === "object" && result !== null && "error" in result) {
        throw new Error(String(result.error));
      }
      const blocks: unknown[] = Array.isArray(result) ? result : [];
      const text = blocks.find(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          block.type === "text" &&
          "text" in block &&
          typeof block.text === "string",
      );
      if (!text) throw new Error("The lookup returned no text.");
      return { content: JSON.stringify({ type: "result", content: text.text }) };
    },
  };

  const runtime = new AgentRuntime({
    llmAdapter,
    memoryAdapter: new InMemoryMemoryAdapter(),
  });
  await Agent.define({
    id: "order-assistant",
    projectId,
    systemPrompt: "Look up the requested order and report its status.",
    tools: toolIds,
    llm: { provider: "demo", model: "scripted" },
  });
  const session = new Session({ id: "order-conversation", projectId });
  const agent = await Agent.load("order-assistant", runtime, { session });
  const run = await agent.run(`What is the status of ${orderId}?`);
  const result = run.history.find((step) => step.type === "result");
  if (run.status !== "completed" || typeof result?.content !== "string") {
    throw new Error(run.state.failedReason ?? "The run returned no order status.");
  }
  console.log(result.content);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.close();
}
