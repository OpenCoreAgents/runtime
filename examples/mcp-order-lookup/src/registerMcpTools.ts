import { createHash } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getToolDefinition, resolveToolRegistry, Tool } from "@opencoreagents/core";

/** Build a stable Core tool ID from the project, connection namespace, and remote name. */
export function mcpToolId(projectId: string, namespace: string, name: string): string {
  const identity = JSON.stringify([projectId, namespace, name]);
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  const label = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24);
  return `mcp_${label}_${hash}`;
}

/** Register a selected set of tools from a connected MCP client in one project. */
export async function registerMcpTools(
  client: Client,
  projectId: string,
  namespace: string,
  allowedNames: readonly string[] | "*",
): Promise<string[]> {
  if (!projectId.trim() || !namespace.trim()) {
    throw new Error("The MCP project ID and connection namespace are required.");
  }

  const names = allowedNames === "*" ? ["*"] : [...new Set(allowedNames)];
  const includeAll = names.includes("*");
  if (includeAll && names.length !== 1) {
    throw new Error('Use "*" by itself to register all MCP tools.');
  }
  if (names.length === 0) return [];

  const discovered = new Map<string, Awaited<ReturnType<Client["listTools"]>>["tools"][number]>();
  let cursor: string | undefined;
  const visitedCursors = new Set<string>();

  do {
    if (cursor !== undefined) {
      if (visitedCursors.has(cursor)) throw new Error("MCP server repeated a catalog cursor.");
      visitedCursors.add(cursor);
    }
    const page = await client.listTools(cursor === undefined ? undefined : { cursor }, {
      timeout: 5_000,
    });
    for (const tool of page.tools) {
      discovered.set(tool.name, tool);
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined && (includeAll || names.some((name) => !discovered.has(name))));

  const selected = (includeAll ? [...discovered.keys()] : names).map((name) => {
    const tool = discovered.get(name);
    if (!tool) throw new Error(`MCP server does not expose tool "${name}".`);
    return { id: mcpToolId(projectId, namespace, name), tool };
  });

  const reserved = new Set(resolveToolRegistry(projectId).keys());
  for (const { id } of selected) {
    if (reserved.has(id) || getToolDefinition(projectId, id)) {
      throw new Error(`Core tool ID "${id}" is already registered.`);
    }
    reserved.add(id);
  }

  await Promise.all(
    selected.map(({ id, tool }) =>
      Tool.define({
        id,
        projectId,
        description: tool.description,
        inputSchema: tool.inputSchema,
        async execute(input) {
          if (typeof input !== "object" || input === null || Array.isArray(input)) {
            throw new Error("MCP tool arguments must be an object.");
          }

          const result = await client.callTool(
            { name: tool.name, arguments: input as Record<string, unknown> },
            undefined,
            { timeout: 5_000 },
          );
          if (result.isError) {
            const detail = Array.isArray(result.content)
              ? result.content.find((item) => item.type === "text")
              : undefined;
            throw new Error(
              detail?.type === "text" ? detail.text : `MCP tool "${tool.name}" failed.`,
            );
          }
          return result.structuredContent ?? result.content;
        },
      }),
    ),
  );

  return selected.map(({ id }) => id);
}
