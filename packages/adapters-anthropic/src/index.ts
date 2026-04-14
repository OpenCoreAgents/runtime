import type { LLMAdapter, LLMRequest, LLMResponse } from "@opencoreagents/core";
import { rethrowFetchFailure, throwForAnthropicHttpStatus } from "./errors.js";

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

/**
 * Padding user turns must contain **non-whitespace** text — Anthropic returns **400** otherwise
 * (`text content blocks must contain non-whitespace text`).
 */
const SYNTHETIC_USER_PADDING = "Continue.";

type AnthropicMessage = { role: "user" | "assistant"; content: string };

function splitSystemAndMessages(
  messages: LLMRequest["messages"],
): { system: string | undefined; rest: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const rest: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else {
      rest.push({ role: m.role, content: m.content });
    }
  }
  const system = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
  return { system, rest };
}

/** Anthropic requires the first message to be from the `user` role. */
function ensureUserFirst(msgs: AnthropicMessage[]): AnthropicMessage[] {
  if (msgs.length === 0) {
    return [{ role: "user", content: SYNTHETIC_USER_PADDING }];
  }
  if (msgs[0].role === "assistant") {
    return [{ role: "user", content: SYNTHETIC_USER_PADDING }, ...msgs];
  }
  return msgs;
}

/** Anthropic requires strict user/assistant alternation. */
function mergeConsecutiveSameRole(msgs: AnthropicMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

/**
 * Several Claude models return **400** if `messages` ends with **`assistant`** (“does not support
 * assistant message prefill; conversation must end with a user message”). Our engine history often
 * ends on the last assistant `result` / `thought` before the next LLM call — append a minimal user
 * turn so the request is valid.
 */
function ensureUserLast(msgs: AnthropicMessage[]): AnthropicMessage[] {
  if (msgs.length === 0) {
    return [{ role: "user", content: SYNTHETIC_USER_PADDING }];
  }
  if (msgs[msgs.length - 1]!.role === "assistant") {
    return [...msgs, { role: "user", content: SYNTHETIC_USER_PADDING }];
  }
  return msgs;
}

function mapAnthropicStopReason(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "stop";
  switch (raw) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return raw;
  }
}

export type AnthropicLLMAdapterOptions = {
  /** Override default `https://api.anthropic.com/v1` (e.g. proxy or VPC gateway). */
  baseUrl?: string;
  /** `anthropic-version` header; default `2023-06-01`. */
  anthropicVersion?: string;
};

export class AnthropicLLMAdapter implements LLMAdapter {
  private readonly baseUrl: string;
  private readonly anthropicVersion: string;

  constructor(
    private readonly apiKey: string,
    baseUrlOrOptions: string | AnthropicLLMAdapterOptions = {},
  ) {
    const opts: AnthropicLLMAdapterOptions =
      typeof baseUrlOrOptions === "string" ? { baseUrl: baseUrlOrOptions } : baseUrlOrOptions;
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
    this.anthropicVersion = opts.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const { system, rest } = splitSystemAndMessages(request.messages);
    const anthropicMessages = ensureUserLast(mergeConsecutiveSameRole(ensureUserFirst(rest)));

    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      messages: anthropicMessages,
      temperature: request.temperature ?? 0.2,
    };
    if (system != null && system.length > 0) {
      body.system = system;
    }

    const useTools =
      Boolean(request.tools?.length) && request.toolChoice !== "none";
    if (useTools && request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
      body.tool_choice = mapToolChoice(request.toolChoice);
    }

    // Native JSON mode differs by API version; engine JSON protocol is enforced via system prompt.

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": this.anthropicVersion,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (e: unknown) {
      rethrowFetchFailure(e, "Anthropic messages");
    }

    if (!res.ok) {
      const text = await res.text();
      throwForAnthropicHttpStatus(res.status, text);
    }

    const data = (await res.json()) as {
      content?: Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: unknown }
      >;
      stop_reason?: string | null;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const textParts: string[] = [];
    const toolCalls: Array<{ name: string; arguments: string }> = [];
    for (const block of data.content ?? []) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          name: block.name,
          arguments:
            typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
        });
      }
    }

    const usage = data.usage;
    const totalTokens =
      usage?.input_tokens != null && usage?.output_tokens != null
        ? usage.input_tokens + usage.output_tokens
        : undefined;

    return {
      content: textParts.join(""),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: usage
        ? {
            promptTokens: usage.input_tokens,
            completionTokens: usage.output_tokens,
            totalTokens,
          }
        : undefined,
      finishReason: mapAnthropicStopReason(data.stop_reason),
      raw: data,
    };
  }
}

function mapToolChoice(choice: LLMRequest["toolChoice"]): Record<string, unknown> {
  if (choice === "auto" || choice == null) return { type: "auto" };
  if (typeof choice === "object" && choice.type === "tool" && choice.name) {
    return { type: "tool", name: choice.name };
  }
  return { type: "auto" };
}
