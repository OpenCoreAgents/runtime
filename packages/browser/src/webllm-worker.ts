import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

export interface WebLLMWorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
}

/** Attaches WebLLM's engine handler to a dedicated worker global scope. */
export function startWebLLMWorker(scope: WebLLMWorkerScope): WebWorkerMLCEngineHandler {
  const handler = new WebWorkerMLCEngineHandler();
  scope.onmessage = (event) => handler.onmessage(event);
  return handler;
}
