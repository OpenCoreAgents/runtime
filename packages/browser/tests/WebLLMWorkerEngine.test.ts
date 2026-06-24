import type { MLCEngineInterface } from "@mlc-ai/web-llm";
import { describe, expect, it, vi } from "vitest";
import {
  createWebLLMWorkerEngineFactory,
  type WebLLMWorker,
  type WebLLMWorkerEngineCreator,
} from "../src/webllm.js";

function fakeWorker(): WebLLMWorker {
  return {
    onmessage: null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
  };
}

function fakeEngine(): MLCEngineInterface {
  return {
    unload: vi.fn().mockResolvedValue(undefined),
  } as unknown as MLCEngineInterface;
}

describe("createWebLLMWorkerEngineFactory", () => {
  it("creates a worker engine and terminates the worker after unload", async () => {
    const worker = fakeWorker();
    const engine = fakeEngine();
    const originalUnload = engine.unload;
    const createEngine = vi.fn().mockResolvedValue(engine) as WebLLMWorkerEngineCreator;
    const factory = createWebLLMWorkerEngineFactory(() => worker, { createEngine });

    const result = await factory("test-model", {});
    await result.unload();
    await result.unload();

    expect(createEngine).toHaveBeenCalledWith(worker, "test-model", {});
    expect(originalUnload).toHaveBeenCalledTimes(2);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("terminates the worker when engine initialization fails", async () => {
    const worker = fakeWorker();
    const createEngine = vi.fn().mockRejectedValue(new Error("load failed"));
    const factory = createWebLLMWorkerEngineFactory(() => worker, { createEngine });

    await expect(factory("test-model", {})).rejects.toThrow("load failed");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("can leave worker lifecycle ownership with the caller", async () => {
    const worker = fakeWorker();
    const engine = fakeEngine();
    const factory = createWebLLMWorkerEngineFactory(() => worker, {
      createEngine: vi.fn().mockResolvedValue(engine),
      terminateOnUnload: false,
    });

    const result = await factory("test-model", {});
    await result.unload();

    expect(worker.terminate).not.toHaveBeenCalled();
  });
});
