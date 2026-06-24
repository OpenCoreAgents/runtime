import type { MLCEngineConfig, MLCEngineInterface } from "@mlc-ai/web-llm";
import type { WebLLMEngineFactory } from "./WebLLMAdapter.js";

export interface WebLLMWorker {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

export type WebLLMWorkerFactory = () => WebLLMWorker;

export type WebLLMWorkerEngineCreator = (
  worker: WebLLMWorker,
  model: string,
  config: MLCEngineConfig,
) => Promise<MLCEngineInterface>;

export interface WebLLMWorkerEngineFactoryOptions {
  /** Terminates the worker after `engine.unload()`. Defaults to true. */
  terminateOnUnload?: boolean;
  /** Injectable engine creator for custom transports and tests. */
  createEngine?: WebLLMWorkerEngineCreator;
}

async function createDefaultWorkerEngine(
  worker: WebLLMWorker,
  model: string,
  config: MLCEngineConfig,
): Promise<MLCEngineInterface> {
  const { CreateWebWorkerMLCEngine } = await import("@mlc-ai/web-llm");
  return CreateWebWorkerMLCEngine(worker, model, config);
}

/** Creates an adapter-compatible engine factory that performs inference in a module worker. */
export function createWebLLMWorkerEngineFactory(
  workerFactory: WebLLMWorkerFactory,
  options: WebLLMWorkerEngineFactoryOptions = {},
): WebLLMEngineFactory {
  return async (model, config) => {
    const worker = workerFactory();
    const createEngine = options.createEngine ?? createDefaultWorkerEngine;
    let engine: MLCEngineInterface;
    try {
      engine = await createEngine(worker, model, config);
    } catch (error) {
      worker.terminate();
      throw error;
    }

    if (options.terminateOnUnload !== false) {
      const unload = engine.unload.bind(engine);
      let terminated = false;
      engine.unload = async () => {
        try {
          await unload();
        } finally {
          if (!terminated) {
            terminated = true;
            worker.terminate();
          }
        }
      };
    }
    return engine;
  };
}
