import type { LLMAdapter, LLMRequest, LLMResponse } from "@opencoreagents/core";

/** Deterministic LLM — swap for `OpenAILLMAdapter` in a real deployment. */
export class DemoLlm implements LLMAdapter {
  private i = 0;
  async generate(_req: LLMRequest): Promise<LLMResponse> {
    // Alternate thought / result across generate() calls so multiple jobs stay deterministic.
    const phase = this.i++ % 2;
    const content =
      phase === 0
        ? JSON.stringify({
            type: "thought",
            content: "Plan: respond without calling tools for this demo turn.",
          })
        : JSON.stringify({
            type: "result",
            content: "Hello from the worker (Redis definitions + BullMQ).",
          });
    return { content };
  }
}
