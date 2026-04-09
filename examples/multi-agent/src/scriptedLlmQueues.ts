/**
 * Deterministic **Step** JSON for the mock LLM (`QueueLLM` in `main.ts`).
 *
 * On each `generate()` call the adapter returns the next string; the engine parses it like a real
 * model output (`action` → `send_message`, then `result`). Keeps this example free of API keys.
 */

/** Demo 1 — `notifier-agent` → `send_message` **event** → `inventory-agent` inbox. */
export const DEMO_EVENT_LLM_STEPS: readonly string[] = [
  JSON.stringify({
    type: "action",
    tool: "send_message",
    input: {
      toAgentId: "inventory-agent",
      type: "event",
      payload: { sku: "SKU-4412", note: "Refund approved — restock shelf B." },
    },
  }),
  JSON.stringify({
    type: "result",
    content: "Notified inventory-agent.",
  }),
];

/** Demo 2 — `coordinator-agent` → `send_message` **request** (needs runtime `correlationId`). */
export function demoRequestReplyLlmSteps(correlationId: string): string[] {
  return [
    JSON.stringify({
      type: "action",
      tool: "send_message",
      input: {
        toAgentId: "specialist-agent",
        type: "request",
        correlationId,
        payload: { issue: "API 504 after checkout — customer waiting." },
      },
    }),
    JSON.stringify({
      type: "result",
      content: "Escalation sent; awaiting specialist (see parallel handler).",
    }),
  ];
}
