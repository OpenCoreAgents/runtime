import {
  type ChatCompletion,
  type ChatCompletionChunk,
  type ChatCompletionRequestBase,
  type InitProgressReport,
  type MLCEngineConfig,
  type MLCEngineInterface,
} from "@mlc-ai/web-llm";
import {
  RunCancelledError,
  type LLMAdapter,
  type LLMRequest,
  type LLMResponse,
} from "@opencoreagents/core";

export type WebLLMEngineFactory = (
  model: string,
  config: MLCEngineConfig,
) => Promise<MLCEngineInterface>;

export interface WebLLMAdapterOptions {
  /** Model loaded by WebLLM. When omitted, the first `LLMRequest.model` is used. */
  model?: string;
  /** Receives model download, cache, and initialization progress. */
  onProgress?: (report: InitProgressReport) => void;
  /** Additional WebLLM engine configuration. */
  engineConfig?: Omit<MLCEngineConfig, "initProgressCallback">;
  /** Used when an LLM request does not provide its own output-token limit. */
  defaultMaxOutputTokens?: number;
  /** Schema used for generic JSON-object requests. Explicit request schemas take precedence. */
  defaultJsonObjectSchema?: object;
  /** Injectable for Web Workers, Service Workers, and deterministic tests. */
  engineFactory?: WebLLMEngineFactory;
}

async function defaultEngineFactory(
  model: string,
  config: MLCEngineConfig,
): Promise<MLCEngineInterface> {
  if (!isWebGpuAvailable()) {
    throw new Error("WebGPU is unavailable. WebLLM requires a browser with WebGPU support.");
  }
  const { CreateMLCEngine } = await import("@mlc-ai/web-llm");
  return CreateMLCEngine(model, config);
}

export function isWebGpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

function resolveModel(configuredModel: string | undefined, requestedModel: string): string {
  const model = configuredModel?.trim() || requestedModel.trim();
  if (!model) throw new Error("WebLLMAdapter requires a model ID.");
  return model;
}

function mapToolChoice(request: LLMRequest): ChatCompletionRequestBase["tool_choice"] {
  if (typeof request.toolChoice === "string" || request.toolChoice == null) {
    return request.toolChoice;
  }
  return {
    type: "function",
    function: { name: request.toolChoice.name },
  };
}

function mapResponseFormat(
  request: LLMRequest,
  defaultJsonObjectSchema?: object,
): ChatCompletionRequestBase["response_format"] {
  if (!request.responseFormat) return undefined;
  const schema =
    request.responseFormat.type === "json_schema"
      ? request.responseFormat.schema
      : (defaultJsonObjectSchema ?? { type: "object" });
  return {
    type: "json_object",
    // WebLLM's grammar compiler requires a serialized schema even for generic JSON objects.
    schema: JSON.stringify(schema),
  };
}

function buildCompletionRequest(
  request: LLMRequest,
  model: string,
  stream: boolean,
  defaultMaxOutputTokens?: number,
  defaultJsonObjectSchema?: object,
): ChatCompletionRequestBase {
  return {
    model,
    messages: request.messages,
    temperature: request.temperature ?? 0.2,
    max_tokens: request.maxOutputTokens ?? defaultMaxOutputTokens,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function" as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters as Record<string, unknown>,
            },
          })),
          tool_choice: mapToolChoice(request) ?? "auto",
        }
      : {}),
    ...(request.responseFormat
      ? { response_format: mapResponseFormat(request, defaultJsonObjectSchema) }
      : {}),
  };
}

function mapUsage(usage: ChatCompletion["usage"] | ChatCompletionChunk["usage"]):
  | LLMResponse["usage"]
  | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

function mapNonStreamingResponse(response: ChatCompletion): LLMResponse {
  const choice = response.choices[0];
  return {
    content: choice?.message.content ?? "",
    toolCalls: choice?.message.tool_calls?.map((call) => ({
      name: call.function.name,
      arguments: call.function.arguments,
    })),
    usage: mapUsage(response.usage),
    finishReason: choice?.finish_reason ?? "stop",
    raw: response,
  };
}

type StreamingToolCall = { name: string; arguments: string };

async function consumeStreamingResponse(
  chunks: AsyncIterable<ChatCompletionChunk>,
  request: LLMRequest,
): Promise<LLMResponse> {
  let content = "";
  let finishReason: string = "stop";
  let usage: LLMResponse["usage"];
  const toolCalls = new Map<number, StreamingToolCall>();
  const raw: ChatCompletionChunk[] = [];

  for await (const chunk of chunks) {
    raw.push(chunk);
    if (chunk.usage) usage = mapUsage(chunk.usage);
    const choice = chunk.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const text = choice.delta.content ?? "";
    if (text) {
      content += text;
      request.onStreamChunk?.(text);
    }

    for (const fragment of choice.delta.tool_calls ?? []) {
      const current = toolCalls.get(fragment.index) ?? { name: "", arguments: "" };
      current.name += fragment.function?.name ?? "";
      current.arguments += fragment.function?.arguments ?? "";
      toolCalls.set(fragment.index, current);
    }
  }

  return {
    content,
    toolCalls: toolCalls.size ? [...toolCalls.values()] : undefined,
    usage,
    finishReason,
    raw,
  };
}

export class WebLLMAdapter implements LLMAdapter {
  private enginePromise?: Promise<MLCEngineInterface>;
  private loadedModel?: string;

  constructor(private readonly options: WebLLMAdapterOptions = {}) {}

  /** Starts model loading early. `generate()` calls this automatically when needed. */
  async initialize(model?: string): Promise<void> {
    await this.getEngine(resolveModel(model ?? this.options.model, ""));
  }

  /** Releases WebLLM model and GPU resources. */
  async unload(): Promise<void> {
    const engine = await this.enginePromise;
    await engine?.unload();
    this.enginePromise = undefined;
    this.loadedModel = undefined;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    if (request.signal?.aborted) throw new RunCancelledError();
    const model = resolveModel(this.options.model, request.model);
    const engine = await this.getEngine(model);
    if (request.signal?.aborted) throw new RunCancelledError();

    const abort = (): void => engine.interruptGenerate();
    request.signal?.addEventListener("abort", abort, { once: true });

    try {
      if (request.onStreamChunk) {
        const chunks = await engine.chat.completions.create(
          buildCompletionRequest(
            request,
            model,
            true,
            this.options.defaultMaxOutputTokens,
            this.options.defaultJsonObjectSchema,
          ) as ChatCompletionRequestBase & {
            stream: true;
          },
        );
        const response = await consumeStreamingResponse(chunks, request);
        if (request.signal?.aborted) throw new RunCancelledError();
        return response;
      }

      const response = await engine.chat.completions.create(
        buildCompletionRequest(
          request,
          model,
          false,
          this.options.defaultMaxOutputTokens,
          this.options.defaultJsonObjectSchema,
        ) as ChatCompletionRequestBase & {
          stream?: false;
        },
      );
      if (request.signal?.aborted) throw new RunCancelledError();
      return mapNonStreamingResponse(response);
    } catch (error) {
      if (request.signal?.aborted) throw new RunCancelledError();
      throw error;
    } finally {
      request.signal?.removeEventListener("abort", abort);
    }
  }

  private getEngine(model: string): Promise<MLCEngineInterface> {
    if (this.loadedModel && this.loadedModel !== model) {
      throw new Error(
        `WebLLMAdapter is already initialized with ${this.loadedModel}; create another adapter for ${model}.`,
      );
    }
    if (!this.enginePromise) {
      this.loadedModel = model;
      const factory = this.options.engineFactory ?? defaultEngineFactory;
      this.enginePromise = factory(model, {
        ...this.options.engineConfig,
        initProgressCallback: this.options.onProgress,
      }).catch((error: unknown) => {
        this.enginePromise = undefined;
        this.loadedModel = undefined;
        throw error;
      });
    }
    return this.enginePromise;
  }
}
