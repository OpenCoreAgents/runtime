/**
 * RAG + **contact_support**: optional CLI email on **`Session.sessionContext`**; if the user skips,
 * the run ends in **`waiting`**. The host then calls **`Agent.resume(runId, { type: "text", content })`**
 * with the user’s next message (same as prod with a persisted run). **`AgentRuntime`** uses
 * **`InMemoryRunStore`** so the wait/resume round-trip works in this demo. The scripted LLM reads
 * **`LLMRequest.messages`**. **Two turns:** (1) optional RAG-only question (e.g. warranty), (2) refund scenario + ticket.
 */
import readline from "node:readline/promises";
import { stdin as stdinStream, stdout as stdoutStream } from "node:process";
import {
  Agent,
  AgentRuntime,
  Session,
  Skill,
  Tool,
  InMemoryMemoryAdapter,
  InMemoryRunStore,
  type Run,
} from "@agent-runtime/core";
import { registerRagCatalog, registerRagToolsAndSkills } from "@agent-runtime/rag";

import { createDemoEmbeddingAdapter, createDemoVectorAdapter } from "./demoAdapters.js";
import {
  DEMO_FILE_READ_ROOT,
  SUPPORT_CATALOG_ID,
  SUPPORT_RAG_SOURCES,
} from "./fileSources.js";
import { createScriptedSupportLlm } from "./scriptedSupportLlm.js";
import { printRunSummary } from "./printRun.js";

const PROJECT_ID = "support-demo";

function demoTicketId(): string {
  return `demo-ticket-${Date.now().toString(36)}`;
}

function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

const TICKET_CATEGORIES = ["refund", "billing", "technical", "other"] as const;
type TicketCategory = (typeof TICKET_CATEGORIES)[number];

function isTicketCategory(s: string): s is TicketCategory {
  return (TICKET_CATEGORIES as readonly string[]).includes(s);
}

function parseContactSupportInput(input: unknown):
  | { subject: string; body: string; category: TicketCategory; overrideEmail?: string }
  | { error: string } {
  if (input === null || typeof input !== "object") {
    return { error: "Invalid tool input: expected an object." };
  }
  const o = input as Record<string, unknown>;
  const subject = o.subject;
  const body = o.body;
  const category = o.category;
  if (typeof subject !== "string" || !subject.trim()) {
    return { error: "subject is required and must be a non-empty string." };
  }
  if (typeof body !== "string" || !body.trim()) {
    return { error: "body is required and must be a non-empty string." };
  }
  if (typeof category !== "string" || !isTicketCategory(category)) {
    return {
      error: "category must be one of: refund, billing, technical, other.",
    };
  }
  const override =
    typeof o.customerEmail === "string" && o.customerEmail.trim()
      ? o.customerEmail.trim()
      : undefined;
  return {
    subject: subject.trim(),
    body: body.trim(),
    category,
    overrideEmail: override,
  };
}

/** First message to the KB; Enter = default warranty/defects question. */
async function readFirstRagQuestion(): Promise<string> {
  const rl = readline.createInterface({ input: stdinStream, output: stdoutStream });
  try {
    const line = (
      await rl.question(
        "First question to the KB — warranty, defects, etc. (Enter = default): ",
      )
    ).trim();
    return (
      line ||
      "What does the handbook say about warranty coverage and defective items?"
    );
  } finally {
    rl.close();
  }
}

/** Empty line = skip (assistant will ask for email before opening a ticket). */
async function askCustomerEmailOptional(): Promise<string | undefined> {
  const rl = readline.createInterface({ input: stdinStream, output: stdoutStream });
  try {
    for (;;) {
      const line = (
        await rl.question(
          "Your email for support (Enter to skip — assistant asks before ticket): ",
        )
      ).trim();
      if (line === "") return undefined;
      if (looksLikeEmail(line)) return line;
      stdoutStream.write("Enter a valid email, or press Enter to skip.\n");
    }
  } finally {
    rl.close();
  }
}

/**
 * Text passed to **`Agent.resume(..., { type: "text", content })`** — must match prod `resumeInput`.
 * Validates email for this demo; `ref` mirrors host-side session update for the scripted LLM fallback.
 */
async function readUserResumeMessageAsEmail(ref: { current?: string }): Promise<string> {
  const rl = readline.createInterface({ input: stdinStream, output: stdoutStream });
  try {
    for (;;) {
      const line = (await rl.question("You: ")).trim();
      if (looksLikeEmail(line)) {
        ref.current = line;
        return line;
      }
      stdoutStream.write("That doesn’t look like an email; try again (e.g. you@company.com).\n");
    }
  } finally {
    rl.close();
  }
}

function printAssistantWaitFromRun(run: Run): void {
  for (let i = run.history.length - 1; i >= 0; i--) {
    const h = run.history[i]!;
    if (h.type !== "wait") continue;
    const c = h.content as { reason?: string };
    if (typeof c.reason === "string" && c.reason.length > 0) {
      stdoutStream.write(`Assistant: ${c.reason}\n`);
    }
    return;
  }
}

async function main(): Promise<void> {
  if (!SUPPORT_RAG_SOURCES.some((s) => s.id === SUPPORT_CATALOG_ID)) {
    throw new Error(`SUPPORT_CATALOG_ID "${SUPPORT_CATALOG_ID}" missing from SUPPORT_RAG_SOURCES`);
  }

  const firstRagQuestion = await readFirstRagQuestion();
  const cliEmail = await askCustomerEmailOptional();
  const ticketEmailRef: { current?: string } = {};
  if (cliEmail) ticketEmailRef.current = cliEmail;

  const embeddingAdapter = createDemoEmbeddingAdapter();
  const vectorAdapter = createDemoVectorAdapter();

  const runStore = new InMemoryRunStore();

  const runtime = new AgentRuntime({
    llmAdapter: createScriptedSupportLlm({
      catalogIngestId: SUPPORT_CATALOG_ID,
      warrantySearchQuery:
        "warranty limited manufacturing defects order ID proof of purchase claim photos",
      searchQuery: "International order refund shipping costs defective wrong item",
      initialSessionHasEmail: Boolean(cliEmail),
      getEmailForTicket: () => ticketEmailRef.current,
    }),
    memoryAdapter: new InMemoryMemoryAdapter(),
    runStore,
    embeddingAdapter,
    vectorAdapter,
    fileReadRoot: DEMO_FILE_READ_ROOT,
    maxIterations: 20,
  });

  await registerRagToolsAndSkills();

  await Tool.define({
    id: "contact_support",
    scope: "global",
    description:
      "Open a support ticket when the knowledge base is insufficient or the user needs human follow-up. " +
      "Include subject, body with KB context, and category. Customer email for follow-up is usually already on the session (host sets Session.sessionContext.customerEmail); omit customerEmail in the tool input if the host provided it.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Short ticket title" },
        body: { type: "string", description: "Details and what you found in the KB" },
        customerEmail: {
          type: "string",
          description:
            "Optional override; if omitted, the handler uses ToolContext.sessionContext.customerEmail from the host.",
        },
        category: {
          type: "string",
          enum: ["refund", "billing", "technical", "other"],
          description: "Ticket queue hint",
        },
      },
      required: ["subject", "body", "category"],
    },
    roles: ["agent", "admin", "operator"],
    execute: async (input: unknown, ctx) => {
      const parsed = parseContactSupportInput(input);
      if ("error" in parsed) {
        return { success: false, error: parsed.error };
      }
      const fromSession = ctx.sessionContext?.customerEmail;
      const email =
        parsed.overrideEmail ??
        (typeof fromSession === "string" ? fromSession.trim() : "");
      if (!email) {
        return {
          success: false,
          error:
            "Missing customer email: set Session.sessionContext.customerEmail on the session or pass customerEmail in the tool input.",
        };
      }
      // Demo: in production, call your CRM, email, or queue.
      return {
        success: true,
        ticketId: demoTicketId(),
        subject: parsed.subject,
        category: parsed.category,
        customerEmail: email,
      };
    },
  });

  await Skill.define({
    id: "contact-support-skill",
    scope: "global",
    tools: ["contact_support"],
    description: "Escalate to human support with structured ticket fields.",
    roles: ["agent"],
  });

  registerRagCatalog(runtime, PROJECT_ID, SUPPORT_RAG_SOURCES);

  await Agent.define({
    id: "support-copilot",
    projectId: PROJECT_ID,
    systemPrompt: [
      "You are a support copilot.",
      "The host may attach customerEmail on sessionContext; tools see ToolContext.sessionContext.",
      "If there is no email on the session, ask the user for it before calling contact_support.",
      "Use RAG tools: system_list_rag_sources, system_ingest_rag_source, system_vector_search as needed.",
      "contact_support requires subject, body, and category; customer email comes from session context and/or the tool input.",
    ].join(" "),
    tools: [],
    skills: ["rag", "contact-support-skill"],
    llm: { provider: "openai", model: "gpt-4o-mini" },
    security: { roles: ["agent", "admin", "operator"] },
  });

  const session = new Session({
    id: "session-support-1",
    projectId: PROJECT_ID,
    sessionContext: cliEmail ? { customerEmail: cliEmail } : {},
  });

  const agent = await Agent.load("support-copilot", runtime, { session });

  stdoutStream.write("\n--- 1) RAG only (warranty / handbook) ---\n");
  stdoutStream.write(`You: ${firstRagQuestion}\n`);
  const runWarranty = await agent.run(firstRagQuestion);
  printRunSummary(runWarranty);

  const refundMessage =
    "I bought internationally — can I get shipping refunded if I return the item?";

  stdoutStream.write(
    "\n--- 2) Refund + ticket (after `wait`, `agent.resume(runId, { type: \"text\", content })` as in prod) ---\n",
  );
  stdoutStream.write(`You: ${refundMessage}\n`);

  let run = await agent.run(refundMessage);

  if (run.status === "waiting") {
    printAssistantWaitFromRun(run);
    const resumeText = await readUserResumeMessageAsEmail(ticketEmailRef);
    run = await agent.resume(run.runId, { type: "text", content: resumeText });
  }

  printRunSummary(run);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
