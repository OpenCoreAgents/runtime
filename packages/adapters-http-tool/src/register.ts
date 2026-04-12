import { Tool, registerToolHandler, type ToolDefinition } from "@opencoreagents/core";
import { createHttpToolAdapter, type CreateHttpToolAdapterOptions } from "./createHttpToolAdapter.js";
import type { HttpToolConfig } from "./types.js";

function toToolDefinition(config: HttpToolConfig): ToolDefinition {
  const { http: _h, ...rest } = config;
  return rest;
}

/**
 * Registers each tool: {@link Tool.define} (schema only) + HTTP {@link registerToolHandler}.
 */
export async function registerHttpToolsFromDefinitions(
  configs: HttpToolConfig[],
  options: CreateHttpToolAdapterOptions = {},
): Promise<void> {
  for (const config of configs) {
    await Tool.define(toToolDefinition(config));
    registerToolHandler(createHttpToolAdapter(config, options));
  }
}
