import type { ToolDefinition } from "./types.js";
import type { ToolAdapter } from "../adapters/tool/ToolAdapter.js";
import { registerToolDefinition, registerToolHandler } from "./registry.js";

export class Tool {
  static async define(
    def: ToolDefinition & {
      execute?: ToolAdapter["execute"];
      /** Canonicalizes raw model input before validation/policy/approval/execution. */
      prepareInput?: ToolAdapter["prepareInput"];
      /** Legacy structural validation when no `prepareInput` is provided. */
      validate?: ToolAdapter["validate"];
    },
  ): Promise<void> {
    registerToolDefinition(def);
    if (def.execute) {
      registerToolHandler({
        name: def.id,
        description: def.description,
        execute: def.execute,
        ...(def.prepareInput ? { prepareInput: def.prepareInput } : {}),
        ...(def.validate ? { validate: def.validate } : {}),
      });
    }
  }
}
