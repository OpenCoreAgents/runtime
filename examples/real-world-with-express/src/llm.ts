/**
 * Demo LLM: routes by agent system prompt tag. Chat uses OpenAI when OPENAI_API_KEY is set,
 * otherwise a stateless mock. Wait/resume demo is fully scripted from the message list.
 */
import { OpenAILLMAdapter } from "@agent-runtime/adapters-openai";
import type { LLMAdapter, LLMRequest, LLMResponse } from "@agent-runtime/core";

/** Must match strings used in **Agent.define** `systemPrompt` (composite routes on these tags). */
export const EXPRESS_TAG_CHAT = "[EXPRESS_CHAT]";
export const EXPRESS_TAG_WAIT = "[EXPRESS_WAIT]";

const RESUME_PREFIX = "[resume:text]";

function stripExpressTags(req: LLMRequest): LLMRequest {
  const messages = req.messages.map((m) => {
    if (m.role !== "system" || typeof m.content !== "string") return m;
    return {
      ...m,
      content: m.content.replace(EXPRESS_TAG_CHAT, "").replace(EXPRESS_TAG_WAIT, "").trim(),
    };
  });
  return { ...req, messages };
}

function hasResume(messages: LLMRequest["messages"]): boolean {
  return messages.some(
    (m) =>
      m.role === "user" &&
      typeof m.content === "string" &&
      m.content.includes(RESUME_PREFIX),
  );
}

function lastResumeText(messages: LLMRequest["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user" || typeof m.content !== "string") continue;
    if (m.content.includes(RESUME_PREFIX)) {
      const idx = m.content.indexOf(RESUME_PREFIX);
      return m.content.slice(idx + RESUME_PREFIX.length).trim();
    }
  }
  return "";
}

/** Stateless mock: first model call → thought; next → result (no tools). */
function chatMockGenerate(req: LLMRequest): LLMResponse {
  const assistantTurns = req.messages.filter((m) => m.role === "assistant").length;
  if (assistantTurns === 0) {
    return {
      content: JSON.stringify({
        type: "thought",
        content: "Plan a one-line reply for the HTTP client.",
      }),
    };
  }
  return {
    content: JSON.stringify({
      type: "result",
      content:
        "Hello from the Express + agent-runtime example (mock LLM — set OPENAI_API_KEY for a real model).",
    }),
  };
}

function waitDemoGenerate(req: LLMRequest): LLMResponse {
  if (hasResume(req.messages)) {
    const name = lastResumeText(req.messages) || "there";
    return {
      content: JSON.stringify({
        type: "result",
        content: `Thanks, ${name}. This run completed after HTTP POST …/resume (InMemoryRunStore demo).`,
      }),
    };
  }
  return {
    content: JSON.stringify({
      type: "wait",
      reason: "Send the user’s name with POST /v1/runs/:runId/resume (see README).",
    }),
  };
}

export function createExpressDemoLlm(): LLMAdapter {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const openai = apiKey ? new OpenAILLMAdapter(apiKey) : null;

  return {
    async generate(req: LLMRequest): Promise<LLMResponse> {
      const system = req.messages[0];
      const raw = typeof system?.content === "string" ? system.content : "";

      if (raw.includes(EXPRESS_TAG_WAIT)) {
        return waitDemoGenerate(req);
      }

      if (raw.includes(EXPRESS_TAG_CHAT)) {
        if (openai) {
          return openai.generate(stripExpressTags(req));
        }
        return chatMockGenerate(req);
      }

      throw new Error(
        `Express demo LLM: expected system prompt to include ${EXPRESS_TAG_CHAT} or ${EXPRESS_TAG_WAIT}.`,
      );
    },
  };
}
