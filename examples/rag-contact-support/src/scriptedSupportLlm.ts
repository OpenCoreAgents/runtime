/**
 * **Demo only.** Decisions come from **`LLMRequest.messages`** (observations, `wait`, `[resume:text]`).
 * If the **first user line** looks like a warranty/KB question, the script does ingest → search → **result**
 * only. Otherwise it follows the refund / `contact_support` flow (session email or `wait` + resume).
 */
import type { LLMAdapter, LLMRequest, LLMResponse } from "@opencoreagents/core";

export interface ScriptedSupportLlmOptions {
  catalogIngestId: string;
  /** Vector query for the refund / international follow-up run. */
  searchQuery: string;
  /** Vector query when the user’s first message is a warranty / KB info question. */
  warrantySearchQuery: string;
  /** True when `Session.sessionContext.customerEmail` was set at construction. */
  initialSessionHasEmail: boolean;
  /**
   * When the transcript has `[resume:text] …`, email can come from parsing that line; the host can
   * also set the same value (e.g. CLI ref updated before `Agent.resume`) for the scripted
   * `contact_support` step.
   */
  getEmailForTicket: () => string | undefined;
}

const OBS_PREFIX = "Observation:";
/** Same shape as {@link import("@opencoreagents/core").RunBuilder} in-process resume. */
const RESUME_PREFIX = "[resume:text]";

function countObservationTurns(messages: LLMRequest["messages"]): number {
  return messages.filter(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith(OBS_PREFIX),
  ).length;
}

function hasResumeMessage(messages: LLMRequest["messages"]): boolean {
  return messages.some(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith(RESUME_PREFIX),
  );
}

function lastResumePayload(messages: LLMRequest["messages"]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user" || typeof m.content !== "string") continue;
    if (m.content.startsWith(RESUME_PREFIX)) {
      return m.content.slice(RESUME_PREFIX.length).trim();
    }
  }
  return undefined;
}

function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** First non-tool user line in this run (not `Observation:` / `[resume:…]`). */
function initialUserQuestion(messages: LLMRequest["messages"]): string {
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content !== "string") continue;
    if (m.content.startsWith(OBS_PREFIX) || m.content.startsWith(RESUME_PREFIX)) continue;
    return m.content;
  }
  return "";
}

function isWarrantyInfoTurn(question: string): boolean {
  return /\bwarrant(y|ies)\b/i.test(question) || /\bdefect(ive|s)?\b/i.test(question);
}

export function createScriptedSupportLlm(opts: ScriptedSupportLlmOptions): LLMAdapter {
  const {
    catalogIngestId,
    searchQuery,
    warrantySearchQuery,
    initialSessionHasEmail,
    getEmailForTicket,
  } = opts;

  const ingest = (): LLMResponse => ({
    content: JSON.stringify({
      type: "action",
      tool: "system_ingest_rag_source",
      input: { id: catalogIngestId },
    }),
  });

  const search = (query: string): LLMResponse => ({
    content: JSON.stringify({
      type: "action",
      tool: "system_vector_search",
      input: { query, topK: 5 },
    }),
  });

  const wait = (): LLMResponse => ({
    content: JSON.stringify({
      type: "wait",
      reason:
        "I need your email address before I can open a human support ticket. Please send it in your next message.",
    }),
  });

  const contactFromSession = (): LLMResponse => ({
    content: JSON.stringify({
      type: "action",
      tool: "contact_support",
      input: {
        subject: "Refund policy — international order",
        body:
          "Customer asked about refunds on international orders. " +
          "KB mentions 30-day window and non-refundable shipping unless defective/wrong item. " +
          "Customer email was attached by the host via Session.sessionContext.",
        category: "refund",
      },
    }),
  });

  const contactAfterResume = (email: string): LLMResponse => ({
    content: JSON.stringify({
      type: "action",
      tool: "contact_support",
      input: {
        subject: "Refund policy — international order",
        body:
          "Customer asked about refunds on international orders. " +
          "KB mentions 30-day window and non-refundable shipping unless defective/wrong item. " +
          "Customer provided email in the follow-up message after the assistant asked.",
        category: "refund",
        ...(email ? { customerEmail: email } : {}),
      },
    }),
  });

  const resultFromSession = (): LLMResponse => ({
    content: JSON.stringify({
      type: "result",
      content:
        "Summary: International refunds follow a 30-day window where law allows; return shipping may not be refunded unless the item was wrong or defective. " +
        "Your email was taken from session context for the support ticket.",
    }),
  });

  const resultAfterResume = (): LLMResponse => ({
    content: JSON.stringify({
      type: "result",
      content:
        "Summary: International refunds follow a 30-day window where law allows; return shipping may not be refunded unless the item was wrong or defective. " +
        "Your email was used from your message for the support ticket.",
    }),
  });

  const resultWarrantyOnly = (): LLMResponse => ({
    content: JSON.stringify({
      type: "result",
      content:
        "From the handbook: hardware is covered by a **1-year limited warranty** from delivery against manufacturing defects (keep order ID and proof of purchase). " +
        "Accidental damage, normal wear, and unauthorized repairs are not covered. " +
        "For a claim, contact support with photos and your order ID; you may need to return the item for inspection.",
    }),
  });

  return {
    async generate(req: LLMRequest): Promise<LLMResponse> {
      const messages = req.messages;
      const obs = countObservationTurns(messages);
      const resumed = hasResumeMessage(messages);
      const payload = lastResumePayload(messages);
      const emailFromTranscript =
        payload && looksLikeEmail(payload) ? payload : "";
      const email =
        (getEmailForTicket()?.trim() || emailFromTranscript).trim();

      const firstQ = initialUserQuestion(messages);
      const warrantyOnly = isWarrantyInfoTurn(firstQ) && !resumed;

      if (warrantyOnly) {
        if (obs === 0) return ingest();
        if (obs === 1) return search(warrantySearchQuery);
        return resultWarrantyOnly();
      }

      if (initialSessionHasEmail) {
        if (obs === 0) return ingest();
        if (obs === 1) return search(searchQuery);
        if (obs === 2) return contactFromSession();
        return resultFromSession();
      }

      if (obs === 0) return ingest();
      if (obs === 1) return search(searchQuery);
      if (obs === 2 && !resumed) return wait();
      if (obs === 2 && resumed) return contactAfterResume(email);
      if (obs >= 3) return resultAfterResume();

      return resultAfterResume();
    },
  };
}
