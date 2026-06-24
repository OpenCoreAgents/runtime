import type {
  ChatCompletion,
  ChatCompletionChunk,
  MLCEngineInterface,
} from "@mlc-ai/web-llm";
import { RunCancelledError } from "@opencoreagents/core";
import { describe, expect, it, vi } from "vitest";
import { WebLLMAdapter, type WebLLMEngineFactory } from "../src/webllm.js";

function completion(content: string): ChatCompletion {
  return {
    id: "completion-1",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        logprobs: null,
        message: { role: "assistant", content },
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      extra: {
        e2e_latency_s: 1,
        prefill_tokens_per_s: 1,
        decode_tokens_per_s: 1,
        time_to_first_token_s: 1,
        time_per_output_token_s: 1,
      },
    },
  };
}

function fakeEngine(create: ReturnType<typeof vi.fn>): MLCEngineInterface {
  return {
    chat: { completions: { create } },
    interruptGenerate: vi.fn(),
    unload: vi.fn().mockResolvedValue(undefined),
  } as unknown as MLCEngineInterface;
}

describe("WebLLMAdapter", () => {
  it("loads once and maps a local completion", async () => {
    const create = vi.fn().mockResolvedValue(completion('{"type":"result","content":"done"}'));
    const engine = fakeEngine(create);
    const factory = vi.fn().mockResolvedValue(engine) as WebLLMEngineFactory;
    const onProgress = vi.fn();
    const adapter = new WebLLMAdapter({
      model: "test-model",
      engineFactory: factory,
      onProgress,
      defaultMaxOutputTokens: 128,
    });

    const request = {
      provider: "local",
      model: "ignored-request-model",
      messages: [{ role: "user" as const, content: "hello" }],
      responseFormat: { type: "json_schema" as const, schema: { type: "object" } },
    };
    const first = await adapter.generate(request);
    await adapter.generate(request);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(
      "test-model",
      expect.objectContaining({ initProgressCallback: onProgress }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-model",
        stream: false,
        max_tokens: 128,
        response_format: {
          type: "json_object",
          schema: JSON.stringify({ type: "object" }),
        },
      }),
    );
    expect(first.content).toBe('{"type":"result","content":"done"}');
    expect(first.usage?.totalTokens).toBe(14);
  });

  it("prefers a request output-token limit over the adapter default", async () => {
    const create = vi.fn().mockResolvedValue(completion('{"type":"result","content":"done"}'));
    const adapter = new WebLLMAdapter({
      model: "test-model",
      defaultMaxOutputTokens: 128,
      engineFactory: vi.fn().mockResolvedValue(fakeEngine(create)),
    });

    await adapter.generate({
      provider: "local",
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 64,
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 64 }));
  });

  it("provides WebLLM a schema for generic JSON object output", async () => {
    const create = vi.fn().mockResolvedValue(completion('{"type":"result","content":"done"}'));
    const adapter = new WebLLMAdapter({
      model: "test-model",
      engineFactory: vi.fn().mockResolvedValue(fakeEngine(create)),
    });

    await adapter.generate({
      provider: "local",
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      responseFormat: { type: "json_object" },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        response_format: {
          type: "json_object",
          schema: JSON.stringify({ type: "object" }),
        },
      }),
    );
  });

  it("uses the configured default schema only for generic JSON object output", async () => {
    const create = vi.fn().mockResolvedValue(completion('{"type":"result","content":"done"}'));
    const schema = {
      type: "object",
      properties: { type: { const: "result" }, content: { type: "string" } },
      required: ["type", "content"],
    };
    const adapter = new WebLLMAdapter({
      model: "test-model",
      defaultJsonObjectSchema: schema,
      engineFactory: vi.fn().mockResolvedValue(fakeEngine(create)),
    });

    await adapter.generate({
      provider: "local",
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      responseFormat: { type: "json_object" },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        response_format: { type: "json_object", schema: JSON.stringify(schema) },
      }),
    );
  });

  it("maps tools and forced tool choice", async () => {
    const response = completion("");
    response.choices[0]!.finish_reason = "tool_calls";
    response.choices[0]!.message.tool_calls = [
      {
        id: "0",
        type: "function",
        function: { name: "lookup", arguments: '{"symbol":"NQ"}' },
      },
    ];
    const create = vi.fn().mockResolvedValue(response);
    const adapter = new WebLLMAdapter({
      model: "test-model",
      engineFactory: vi.fn().mockResolvedValue(fakeEngine(create)),
    });

    const result = await adapter.generate({
      provider: "local",
      model: "test-model",
      messages: [{ role: "user", content: "look up NQ" }],
      tools: [
        {
          name: "lookup",
          description: "Look up a symbol",
          parameters: { type: "object", properties: { symbol: { type: "string" } } },
        },
      ],
      toolChoice: { type: "tool", name: "lookup" },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        tool_choice: { type: "function", function: { name: "lookup" } },
      }),
    );
    expect(result.toolCalls).toEqual([{ name: "lookup", arguments: '{"symbol":"NQ"}' }]);
  });

  it("streams text and combines tool-call fragments", async () => {
    async function* chunks(): AsyncIterable<ChatCompletionChunk> {
      yield {
        id: "chunk-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            finish_reason: null,
            delta: {
              content: "hel",
              tool_calls: [{ index: 0, function: { name: "look", arguments: '{"x":' } }],
            },
          },
        ],
      };
      yield {
        id: "chunk-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            delta: {
              content: "lo",
              tool_calls: [{ index: 0, function: { name: "up", arguments: "1}" } }],
            },
          },
        ],
      };
    }

    const create = vi.fn().mockResolvedValue(chunks());
    const onStreamChunk = vi.fn();
    const adapter = new WebLLMAdapter({
      model: "test-model",
      engineFactory: vi.fn().mockResolvedValue(fakeEngine(create)),
    });
    const result = await adapter.generate({
      provider: "local",
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      onStreamChunk,
    });

    expect(result.content).toBe("hello");
    expect(onStreamChunk.mock.calls).toEqual([["hel"], ["lo"]]);
    expect(result.toolCalls).toEqual([{ name: "lookup", arguments: '{"x":1}' }]);
    expect(result.finishReason).toBe("tool_calls");
  });

  it("rejects an already cancelled request without loading a model", async () => {
    const factory = vi.fn() as WebLLMEngineFactory;
    const adapter = new WebLLMAdapter({ model: "test-model", engineFactory: factory });
    const controller = new AbortController();
    controller.abort();

    await expect(
      adapter.generate({
        provider: "local",
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RunCancelledError);
    expect(factory).not.toHaveBeenCalled();
  });

  it("unloads model resources and permits reinitialization", async () => {
    const engine = fakeEngine(vi.fn().mockResolvedValue(completion("done")));
    const factory = vi.fn().mockResolvedValue(engine) as WebLLMEngineFactory;
    const adapter = new WebLLMAdapter({ model: "test-model", engineFactory: factory });

    await adapter.initialize();
    await adapter.unload();
    await adapter.initialize();

    expect(engine.unload).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
