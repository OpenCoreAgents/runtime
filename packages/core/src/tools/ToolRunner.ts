import type { ToolAdapter, ToolContext } from "../adapters/tool/ToolAdapter.js";
import {
  ToolExecutionError,
  ToolNotAllowedError,
  ToolPreparationError,
  ToolTimeoutError,
  ToolValidationError,
} from "../errors/index.js";

function validationFailureMessage(toolName: string, reason?: string): string {
  const base = `Validation failed for tool: ${toolName}`;
  return reason && reason.trim() ? `${base}: ${reason.trim()}` : base;
}

function preparationFailureMessage(toolName: string, reason?: string): string {
  const base = `Preparation failed for tool: ${toolName}`;
  return reason && reason.trim() ? `${base}: ${reason.trim()}` : base;
}

function normalizeValidation(
  validation: { ok: boolean; reason?: string } | boolean,
): { ok: boolean; reason?: string } {
  if (typeof validation === "boolean") {
    return { ok: validation };
  }
  return { ok: Boolean(validation && validation.ok), reason: validation?.reason };
}

export interface ToolRunnerOptions {
  /** When set (> 0), `execute` rejects with {@link ToolTimeoutError} if the tool does not settle in time. */
  toolTimeoutMs?: number;
}

export type PreparedToolAction =
  | {
      ok: true;
      tool: ToolAdapter;
      toolName: string;
      rawInput: unknown;
      preparedInput: unknown;
    }
  | {
      ok: false;
      toolName: string;
      reason: string;
      details?: string;
      kind: "not_allowed" | "unknown" | "validation" | "preparation";
    };

export class ToolRunner {
  constructor(
    private readonly registry: Map<string, ToolAdapter>,
    private readonly allowlist: Set<string>,
    private readonly options: ToolRunnerOptions = {},
  ) {}

  register(tool: ToolAdapter): void {
    this.registry.set(tool.name, tool);
  }

  async prepare(name: string, rawInput: unknown): Promise<PreparedToolAction> {
    const tool = this.registry.get(name);
    if (!tool) {
      return {
        ok: false,
        toolName: name,
        reason: `Unknown tool: ${name}`,
        kind: "unknown",
      };
    }

    if (!this.allowlist.has(name)) {
      return {
        ok: false,
        toolName: name,
        reason: `Tool not allowed for agent: ${name}`,
        kind: "not_allowed",
      };
    }

    if (tool.prepareInput) {
      const preparation = await tool.prepareInput(rawInput);
      if (!preparation.ok) {
        return {
          ok: false,
          toolName: name,
          reason: preparationFailureMessage(name, preparation.reason),
          details: preparation.reason,
          kind: "preparation",
        };
      }
      return {
        ok: true,
        tool,
        toolName: name,
        rawInput,
        preparedInput: preparation.value,
      };
    }

    if (tool.validate) {
      const validation = normalizeValidation(tool.validate(rawInput));
      if (!validation.ok) {
        return {
          ok: false,
          toolName: name,
          reason: validationFailureMessage(name, validation.reason),
          details: validation.reason,
          kind: "validation",
        };
      }
    }

    return {
      ok: true,
      tool,
      toolName: name,
      rawInput,
      preparedInput: rawInput,
    };
  }

  async executePrepared(
    prepared: PreparedToolAction,
    context: ToolContext,
  ): Promise<unknown> {
    if (!prepared.ok) {
      switch (prepared.kind) {
        case "not_allowed":
          throw new ToolNotAllowedError(prepared.reason);
        case "unknown":
          throw new ToolExecutionError(prepared.reason);
        case "validation":
          throw new ToolValidationError(prepared.reason, prepared.details);
        case "preparation":
          throw new ToolPreparationError(prepared.reason, prepared.details);
      }
    }

    // Defensive: a PreparedToolAction must come from prepare(). If one is
    // fabricated or the registry/allowlist changed after prepare(), reject it.
    if (this.registry.get(prepared.toolName) !== prepared.tool) {
      throw new ToolExecutionError(`Tool is no longer registered: ${prepared.toolName}`);
    }
    if (!this.allowlist.has(prepared.toolName)) {
      throw new ToolNotAllowedError(`Tool not allowed for agent: ${prepared.toolName}`);
    }

    const { tool, toolName, preparedInput } = prepared;
    const run = tool.execute(preparedInput, context);
    const bounded =
      this.options.toolTimeoutMs != null && this.options.toolTimeoutMs > 0
        ? raceWithTimeout(run, this.options.toolTimeoutMs, toolName)
        : run;
    try {
      return await bounded;
    } catch (e) {
      if (e instanceof ToolTimeoutError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new ToolExecutionError(msg);
    }
  }

  async execute(
    name: string,
    input: unknown,
    context: ToolContext,
  ): Promise<unknown> {
    const prepared = await this.prepare(name, input);
    return this.executePrepared(prepared, context);
  }
}

function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  toolName: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ToolTimeoutError(`Tool timed out after ${ms}ms: ${toolName}`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}
