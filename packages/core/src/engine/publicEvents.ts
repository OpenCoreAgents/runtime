import type { EngineDeps } from "./types.js";

/** Version bump only on breaking shape changes; additive fields keep "1". */
export const PUBLIC_RUN_EVENT_SCHEMA_VERSION = "1";

/** Fields present on every public run event. */
export interface PublicRunEventBase {
  schemaVersion: typeof PUBLIC_RUN_EVENT_SCHEMA_VERSION;
  eventId: string;
  /** ISO-8601 timestamp. */
  ts: string;
  runId: string;
  agentId: string;
  sessionId?: string;
  projectId?: string;
  tenantId?: string;
}

export type PublicRunEventType =
  | "run_started"
  | "run_resumed"
  | "run_completed"
  | "run_failed"
  | "run_cancelled"
  | "run_waiting"
  | "tool_proposed"
  | "tool_denied"
  | "tool_awaiting_approval"
  | "tool_started"
  | "tool_completed"
  | "tool_failed"
  | "usage_updated";

/** Per-type payloads. All values are JSON-serializable after redaction. */
export type PublicRunEvent = PublicRunEventBase &
  (
    | { type: "run_started" }
    | { type: "run_resumed" }
    | { type: "run_completed" }
    | { type: "run_failed"; code?: string; error?: string }
    | { type: "run_cancelled"; reason?: string }
    | {
        type: "run_waiting";
        /** `user_input` (model wait) or `tool_approval` (policy wait). */
        pendingKind: "user_input" | "tool_approval";
        reason?: string;
        actionId?: string;
      }
    | { type: "tool_proposed"; tool: string }
    | {
        type: "tool_denied";
        tool: string;
        code: string;
        reason?: string;
        /**
         * Why the tool was denied:
         * - `policy`: a policy / execution-policy / registry check refused it.
         * - `rejected`: a host explicitly rejected a pending action.
         * Absent for legacy consumers (treat as `policy`).
         */
        cause?: "policy" | "rejected";
      }
    | {
        type: "tool_awaiting_approval";
        tool: string;
        actionId: string;
        reason?: string;
        expiresAt?: string;
      }
    | { type: "tool_started"; tool: string }
    | { type: "tool_completed"; tool: string; durationMs?: number }
    | { type: "tool_failed"; tool: string; code?: string; error?: string }
    | { type: "usage_updated"; usage?: Record<string, number> }
  );

/**
 * Consumer sink for public run events. Configure via
 * `EngineConfig.eventSinks`. See {@link RunEventEmissionOptions} for the
 * failure contract.
 */
export type RunEventSink = (event: PublicRunEvent) => void | Promise<void>;

export type RedactionKind =
  | "tool_input"
  | "tool_output"
  | "llm_raw"
  | "event"
  | "history";

export interface RedactionContext {
  runId: string;
  agentId?: string;
  toolName?: string;
}

/**
 * Host hook applied before delivery. Return the (possibly transformed) value;
 * returning `undefined` removes the value. Applied with `kind: "event"` to
 * every public event right before sinking.
 */
export type Redactor = (input: {
  kind: RedactionKind;
  value: unknown;
  context: RedactionContext;
}) => unknown;

export interface RunEventEmissionOptions {
  /**
   * Default `false`: a throwing/rejecting sink is swallowed so telemetry can
   * never fail a run. When `true`, emission errors propagate to the caller.
   */
  failOnEventSinkError?: boolean;
}

/** Per-type payloads (envelope fields omitted), distributive over the union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
export type PublicRunEventPayload = DistributiveOmit<
  PublicRunEvent,
  keyof PublicRunEventBase
>;

/**
 * Applies the configured redactor to the event and delivers it to every sink.
 * Never throws unless `failOnEventSinkError` is set.
 */
export async function emitPublicRunEvent(
  deps: Pick<EngineDeps, "eventSinks" | "redactor" | "failOnEventSinkError">,
  base: {
    runId: string;
    agentId: string;
    sessionId?: string;
    projectId?: string;
    tenantId?: string;
  },
  event: PublicRunEventPayload,
  options: RunEventEmissionOptions = {},
): Promise<void> {
  const sinks = deps.eventSinks;
  if (!sinks || sinks.length === 0) return;

  let out: PublicRunEvent = {
    ...base,
    schemaVersion: PUBLIC_RUN_EVENT_SCHEMA_VERSION,
    eventId: generateEventId(),
    ts: new Date().toISOString(),
    ...event,
  } as PublicRunEvent;

  if (deps.redactor) {
    const redacted = deps.redactor({
      kind: "event",
      value: out,
      context: { runId: base.runId, agentId: base.agentId },
    });
    if (redacted === undefined) return;
    out = redacted as PublicRunEvent;
  }

  await Promise.all(
    sinks.map(async (sink) => {
      try {
        await sink(out);
      } catch (e) {
        if (options.failOnEventSinkError ?? deps.failOnEventSinkError) {
          throw e;
        }
        // Default: telemetry failures never fail the run.
      }
    }),
  );
}

let eventSeq = 0;
function generateEventId(): string {
  eventSeq = (eventSeq + 1) % Number.MAX_SAFE_INTEGER;
  return `evt_${Date.now().toString(36)}_${eventSeq.toString(36)}`;
}