import type { LLMAdapter, LLMRequest, LLMResponse } from "@agent-runtime/core";

/**
 * OpenAI may return native `tool_calls` with empty `content` while the engine only
 * parses JSON protocol steps from `content`. This wrapper turns the first tool call
 * into `{ "type":"action","tool","input" }` so `parseStep` succeeds.
 */
export class OpenAiProtocolBridgeLlm implements LLMAdapter {
  constructor(private readonly inner: LLMAdapter) {}

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const res = await this.inner.generate(request);
    const trimmed = res.content?.trim() ?? "";
    if (trimmed.length > 0) return res;

    const tc = res.toolCalls?.[0];
    if (!tc) return res;

    let input: unknown = {};
    try {
      input = tc.arguments ? (JSON.parse(tc.arguments) as unknown) : {};
    } catch {
      input = { _rawArguments: tc.arguments };
    }

    return {
      ...res,
      content: JSON.stringify({
        type: "action",
        tool: tc.name,
        input,
      }),
      toolCalls: undefined,
    };
  }
}
