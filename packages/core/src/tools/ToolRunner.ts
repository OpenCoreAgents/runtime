import type {
  ToolAdapter,
  ToolContext,
  ToolInputPreparation,
} from "../adapters/tool/ToolAdapter.js";
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
  /** Internal identity marker for objects produced by {@link prepare}. */
  private readonly preparedActions = new WeakSet<object>();

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
      const action: PreparedToolAction = {
        ok: false,
        toolName: name,
        reason: `Unknown tool: ${name}`,
        kind: "unknown",
      };
      this.preparedActions.add(action);
      return action;
    }

    if (!this.allowlist.has(name)) {
      const action: PreparedToolAction = {
        ok: false,
        toolName: name,
        reason: `Tool not allowed for agent: ${name}`,
        kind: "not_allowed",
      };
      this.preparedActions.add(action);
      return action;
    }

    if (tool.prepareInput) {
      let preparation: ToolInputPreparation;
      try {
        preparation = await tool.prepareInput(rawInput);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        const action: PreparedToolAction = {
          ok: false,
          toolName: name,
          reason: preparationFailureMessage(name, reason),
          details: reason,
          kind: "preparation",
        };
        this.preparedActions.add(action);
        return action;
      }
      if (!preparation.ok) {
        const action: PreparedToolAction = {
          ok: false,
          toolName: name,
          reason: preparationFailureMessage(name, preparation.reason),
          details: preparation.reason,
          kind: "preparation",
        };
        this.preparedActions.add(action);
        return action;
      }
      const action: PreparedToolAction = {
        ok: true,
        tool,
        toolName: name,
        rawInput,
        preparedInput: preparation.value,
      };
      this.preparedActions.add(action);
      return action;
    }

    if (tool.validate) {
      const validation = normalizeValidation(tool.validate(rawInput));
      if (!validation.ok) {
        const action: PreparedToolAction = {
          ok: false,
          toolName: name,
          reason: validationFailureMessage(name, validation.reason),
          details: validation.reason,
          kind: "validation",
        };
        this.preparedActions.add(action);
        return action;
      }
    }

    const action: PreparedToolAction = {
      ok: true,
      tool,
      toolName: name,
      rawInput,
      preparedInput: rawInput,
    };
    this.preparedActions.add(action);
    return action;
  }

  async executePrepared(
    prepared: PreparedToolAction,
    context: ToolContext,
  ): Promise<unknown> {
    if (!this.preparedActions.has(prepared)) {
      throw new ToolExecutionError(
        "PreparedToolAction must be produced by the same ToolRunner.prepare() call",
      );
    }

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

    // Defensive: registry/allowlist may have changed after prepare().
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
