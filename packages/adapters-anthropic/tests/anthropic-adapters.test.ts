import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LLMClientError,
  LLMRateLimitError,
  LLMTransportError,
  RunCancelledError,
} from "@opencoreagents/core";
import { AnthropicLLMAdapter } from "../src/index.js";

describe("AnthropicLLMAdapter", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: '{"type":"result","content":"done"}' }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 20 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs /messages and maps response to LLMResponse", async () => {
    const adapter = new AnthropicLLMAdapter("sk-ant-test", "https://api.anthropic.com/v1");
    const out = await adapter.generate({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.3,
    });

    expect(out.content).toBe('{"type":"result","content":"done"}');
    expect(out.finishReason).toBe("stop");
    expect(out.usage?.totalTokens).toBe(30);
    expect(out.usage?.promptTokens).toBe(10);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init?.method).toBe("POST");
    const body = JSON.parse((init?.body as string) ?? "{}");
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(4096);
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("maps system messages to top-level system and merges consecutive roles", async () => {
    const adapter = new AnthropicLLMAdapter("sk-ant-test");
    await adapter.generate({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "sys-a" },
        { role: "system", content: "sys-b" },
        { role: "assistant", content: "a1" },
        { role: "assistant", content: "a2" },
        { role: "user", content: "u1" },
      ],
    });
    const [_, init] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((init?.body as string) ?? "{}");
    expect(body.system).toBe("sys-a\n\nsys-b");
    expect(body.messages).toEqual([
      { role: "user", content: "Continue." },
      { role: "assistant", content: "a1\n\na2" },
      { role: "user", content: "u1" },
    ]);
  });

  it("appends a minimal user message when the transcript ends with assistant (no prefill models)", async () => {
    const adapter = new AnthropicLLMAdapter("sk-ant-test");
    await adapter.generate({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: '{"type":"result","content":"done"}' },
      ],
      temperature: 0.2,
    });
    const [_, init] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((init?.body as string) ?? "{}");
    expect(body.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: '{"type":"result","content":"done"}' },
      { role: "user", content: "Continue." },
    ]);
  });

  it("maps tools to tools + tool_choice auto", async () => {
    const adapter = new AnthropicLLMAdapter("sk-ant-test");
    await adapter.generate({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "x" }],
      tools: [
        {
          name: "echo",
          description: "Echo",
          parameters: { type: "object", properties: { msg: { type: "string" } } },
        },
      ],
      toolChoice: "auto",
    });
    const [_, init] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((init?.body as string) ?? "{}");
    expect(body.tools).toEqual([
      {
        name: "echo",
        description: "Echo",
        input_schema: { type: "object", properties: { msg: { type: "string" } } },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: "auto" });
  });

  it("omits tools when toolChoice is none", async () => {
    const adapter = new AnthropicLLMAdapter("sk-ant-test");
    await adapter.generate({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "x" }],
      tools: [
        {
          name: "echo",
          parameters: { type: "object" },
        },
      ],
      toolChoice: "none",
    });
    const [_, init] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((init?.body as string) ?? "{}");
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it("maps tool_use blocks to toolCalls", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "echo_tool",
              input: { msg: "hi" },
            },
          ],
          stop_reason: "tool_use",
        }),
        { status: 200 },
      ),
    );
    const adapter = new AnthropicLLMAdapter("sk-ant-test");
    const out = await adapter.generate({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "x" }],
    });
    expect(out.toolCalls).toEqual([{ name: "echo_tool", arguments: '{"msg":"hi"}' }]);
    expect(out.finishReason).toBe("tool_calls");
  });

  it("maps 429 to LLMRateLimitError", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" }),
    );
    const adapter = new AnthropicLLMAdapter("sk-ant-test");
    await expect(
      adapter.generate({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toThrow(LLMRateLimitError);
  });

  it("maps 5xx to LLMTransportError", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("bad gateway", { status: 502 }));
    const adapter = new AnthropicLLMAdapter("sk-ant-test");
    await expect(
      adapter.generate({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toThrow(LLMTransportError);
  });

  it("maps other 4xx to LLMClientError", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    const adapter = new AnthropicLLMAdapter("sk-ant-test");
    await expect(
      adapter.generate({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toThrow(LLMClientError);
  });

  it("wraps fetch network errors in LLMTransportError", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const adapter = new AnthropicLLMAdapter("sk-ant-test");
    await expect(
      adapter.generate({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toThrow(LLMTransportError);
  });

  it("maps fetch AbortError to RunCancelledError", async () => {
    const aborted = new Error("The operation was aborted");
    aborted.name = "AbortError";
    vi.mocked(fetch).mockRejectedValueOnce(aborted);
    const adapter = new AnthropicLLMAdapter("sk-ant-test");
    await expect(
      adapter.generate({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toThrow(RunCancelledError);
  });
});
