import type { EngineHookRunContext } from "./types.js";

/**
 * Minimal public tool-action events emitted from the engine action pipeline.
 *
 * This is the first stable projection of the tool-action lifecycle, intended to
 * become the public event model (see `brainstorm/policy-approval-and-events-hardening.md` §8).
 * It is deliberately **independent** of the low-level observer {@link EngineHooks} API.
 *
 * Events are JSON-serializable. Raw tool **input** / **output** are only
 * included when the runtime explicitly opts in via `toolEventsIncludeInputOutput`
 * (see {@link EngineConfig}) — never by default.
 */
export type ToolActionEventType =
  | "tool_proposed"
  | "tool_denied"
  | "tool_awaiting_approval"
  | "tool_started"
  | "tool_completed"
  | "tool_failed";

/** Fields shared by every tool-action event. */
export interface ToolActionEventContext extends EngineHookRunContext {
  /** ISO-8601 timestamp at emission. */
  ts: string;
  /** Tool name used to resolve the action. */
  tool: string;
}

/**
 * A single tool-action lifecycle event, discriminated by {@link ToolActionEventType}.
 *
 * `input` (on `tool_proposed`) is the **prepared** canonical input, not the raw
 * model output, and is only present when `toolEventsIncludeInputOutput` is set.
 */
export type ToolActionEvent =
  | (ToolActionEventContext & { type: "tool_proposed"; input?: unknown })
  | (ToolActionEventContext & {
      type: "tool_denied";
      reason?: string;
      /** Stable error code, e.g. `EXECUTION_POLICY_DENIED`. */
      code: string;
    })
  | (ToolActionEventContext & {
      type: "tool_awaiting_approval";
      reason?: string;
    })
  | (ToolActionEventContext & { type: "tool_started" })
  | (ToolActionEventContext & { type: "tool_completed"; output?: unknown })
  | (ToolActionEventContext & {
      type: "tool_failed";
      /** Sanitized error message (same value as the safe failure observation). */
      error?: string;
      /** Stable error code, e.g. `TOOL_EXECUTION_ERROR`. */
      code?: string;
    });

/** Optional sink for tool-action events. Configure via `EngineConfig.toolEventSink`. */
export type ToolActionEventSink = (event: ToolActionEvent) => void;

/**
 * Builds a tool-action event and forwards it to the configured sink.
 * `includeInput` / `includeOutput` control whether raw tool values are attached.
 */
export interface ToolActionEventOptions {
  includeInput?: boolean;
  includeOutput?: boolean;
}

/** Destructuring helper kept for symmetry with other engine modules. */
export function buildToolActionEvent(
  base: ToolActionEventContext,
  extra: Record<string, unknown>,
  options: ToolActionEventOptions,
): ToolActionEvent {
  const includeInput = Boolean(options.includeInput);
  const includeOutput = Boolean(options.includeOutput);
  const out: Record<string, unknown> = { ...base, ...extra };
  if (extra.input !== undefined && !includeInput) delete out.input;
  if (extra.output !== undefined && !includeOutput) delete out.output;
  return out as unknown as ToolActionEvent;
}