import type Redis from "ioredis";
import type {
  EngineHookRunContext,
  EngineHooks,
  EngineJobPayload,
  LLMParseOutcome,
  LLMResponse,
  RunStatus,
  Step,
} from "@opencoreagents/core";

const MAX_JSON = 32_000;

function channel(keyPrefix: string, runId: string): string {
  const p = keyPrefix.replace(/:+$/, "").trim() || "def";
  return `${p}:runEvents:${runId}`;
}

export function runEventsRedisChannel(definitionsKeyPrefix: string, runId: string): string {
  return channel(definitionsKeyPrefix.trim() || "def", runId);
}

/** When **`invoke_planner`** sets **`sessionContext.invokedBySessionId`**, planner job completion is also published here for SSE **`/v1/chat/stream`**. */
export function chatNotifyRedisChannel(definitionsKeyPrefix: string, chatSessionId: string): string {
  const p = definitionsKeyPrefix.replace(/:+$/, "").trim() || "def";
  return `${p}:chatNotify:${chatSessionId}`;
}

/**
 * **`invoke_planner`** stores the caller’s session in **`sessionContext.invokedBySessionId`** (see **`invokePlannerTool.ts`**).
 */
export function extractInvokedByChatSessionIdFromJobPayload(
  payload: EngineJobPayload,
): string | undefined {
  if (payload.kind !== "run") return undefined;
  const sc = payload.sessionContext;
  if (sc == null || typeof sc !== "object") return undefined;
  const v = (sc as Record<string, unknown>).invokedBySessionId;
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function safeJson(obj: unknown): string {
  try {
    const s = JSON.stringify(obj, (_k, v) => {
      if (typeof v === "string" && v.length > 8000) {
        return `${v.slice(0, 8000)}…`;
      }
      return v;
    });
    return s.length > MAX_JSON ? `${s.slice(0, MAX_JSON)}…` : s;
  } catch {
    return `{"error":"serialize_error"}`;
  }
}

function publish(
  redis: Redis,
  definitionsKeyPrefix: string,
  ctx: EngineHookRunContext,
  payload: Record<string, unknown>,
): void {
  const msg = safeJson({
    v: 1,
    ts: new Date().toISOString(),
    runId: ctx.runId,
    agentId: ctx.agentId,
    projectId: ctx.projectId,
    ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
    ...payload,
  });
  void redis.publish(channel(definitionsKeyPrefix, ctx.runId), msg).catch((err) => {
    console.error("[opencoreagents-runtime] run event publish failed:", err);
  });
}

function compactLlmSummary(r: LLMResponse): Record<string, unknown> {
  return {
    usage: r.usage,
    finishReason: r.finishReason,
    contentLength: typeof r.content === "string" ? r.content.length : 0,
    contentPreview:
      typeof r.content === "string" && r.content.length > 0 ? r.content.slice(0, 400) : undefined,
    toolCallCount: r.toolCalls?.length ?? 0,
  };
}

export function createRedisRunEventHooks(redis: Redis, definitionsKeyPrefix: string): EngineHooks {
  const prefix = definitionsKeyPrefix.trim() || "def";
  return {
    onLLMResponse: (r, m) => {
      publish(redis, prefix, m, { kind: "llm_response", ...compactLlmSummary(r) });
    },
    onLLMAfterParse: (r, m, outcome: LLMParseOutcome) => {
      publish(redis, prefix, m, { kind: "llm_parse", outcome, ...compactLlmSummary(r) });
    },
    onThought: (step: Step, ctx?: EngineHookRunContext) => {
      if (ctx) publish(redis, prefix, ctx, { kind: "thought", step });
    },
    onAction: (step: Step, ctx?: EngineHookRunContext) => {
      if (ctx) publish(redis, prefix, ctx, { kind: "action", step });
    },
    onObservation: (observation: unknown, ctx?: EngineHookRunContext) => {
      if (ctx) publish(redis, prefix, ctx, { kind: "observation", observation });
    },
    onWait: (step: Step, ctx?: EngineHookRunContext) => {
      if (ctx) publish(redis, prefix, ctx, { kind: "wait", step });
    },
  };
}

export function publishRedisRunDispatchDone(
  redis: Redis,
  definitionsKeyPrefix: string,
  run: {
    runId: string;
    agentId: string;
    projectId?: string;
    sessionId?: string;
    status: RunStatus;
  },
): void {
  const ctx: EngineHookRunContext = {
    runId: run.runId,
    agentId: run.agentId,
    projectId: run.projectId ?? "",
    ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
  };
  publish(redis, definitionsKeyPrefix, ctx, { kind: "dispatch_done", status: run.status });
}

export function publishRedisRunDispatchError(
  redis: Redis,
  definitionsKeyPrefix: string,
  ctx: EngineHookRunContext,
  err: unknown,
): void {
  publish(redis, definitionsKeyPrefix, ctx, {
    kind: "dispatch_error",
    error: err instanceof Error ? err.message : String(err),
  });
}

export function publishRedisChatSessionNotify(
  redis: Redis,
  definitionsKeyPrefix: string,
  chatSessionId: string,
  payload: Record<string, unknown>,
): void {
  const msg = safeJson({
    v: 1,
    ts: new Date().toISOString(),
    chatSessionId,
    ...payload,
  });
  const ch = chatNotifyRedisChannel(definitionsKeyPrefix, chatSessionId);
  void redis.publish(ch, msg).catch((err) => {
    console.error("[opencoreagents-runtime] chat session notify publish failed:", err);
  });
}
