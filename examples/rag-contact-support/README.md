# RAG + contact support (`@agent-runtime/example-rag-contact-support`)

Combines **`@agent-runtime/rag`** (catalog ingest + **`system_vector_search`**) with a **custom** tool **`contact_support`** via **`Tool.define`**. Uses a **scripted LLM** (no API keys) so runs are reproducible.

## Flow (CLI)

1. **First question to the KB** — e.g. warranty/defects (Enter uses a default warranty question). The scripted LLM treats messages matching `warranty` / `defective` as **RAG-only**: ingest → search → **`result`** (no ticket). Any other first message follows the **ticket** path on that run instead.
2. **Email (optional)** — Enter to skip; the agent will **`wait`** and you **`Agent.resume`** with the address before opening a ticket (see below).
3. **`agent.run` #1** — Warranty-style question → RAG only.
4. **`agent.run` #2** — Fixed international refund question → ingest → search → **`contact_support`** (or **`wait`** if no email) → **`Agent.resume(runId, { type: "text", content })`** when needed.

**Session context:** if you typed an email, **`main`** sets **`Session.sessionContext.customerEmail`**; tools read **`ToolContext.sessionContext`**. **`AgentRuntime`** includes **`InMemoryRunStore`** so **`waiting`** runs persist and **`resume`** matches production (swap the store for Redis/DB later).

## Run

From repo root (after `pnpm install`):

```bash
pnpm turbo run build --filter=@agent-runtime/core --filter=@agent-runtime/rag
pnpm --filter @agent-runtime/example-rag-contact-support start
```

Run it **in a normal terminal** (interactive stdin). You will be prompted twice before any agent work: (1) first KB question — press **Enter** for the default warranty question, (2) email — enter an address or **Enter** to skip and use **`wait` + `resume`** on the refund turn.

Piping stdin into this script is **unreliable** in some environments because **`readline`** and non-TTY stdio interact badly with the rest of the demo; prefer interactive runs for a full transcript.

## What to read in the tree

| Path | Role |
|------|------|
| [`data/support-handbook.md`](./data/support-handbook.md) | KB: warranty, refunds, escalation. |
| [`src/main.ts`](./src/main.ts) | `registerRagToolsAndSkills`, **`contact_support`** + skill, catalog, two runs + **`resume`**. |
| [`src/scriptedSupportLlm.ts`](./src/scriptedSupportLlm.ts) | Scripted steps driven by **`LLMRequest.messages`** (observations, `wait`, `[resume:text]`). |
| [`src/fileSources.ts`](./src/fileSources.ts) | Catalog id + data dir. |
| [`src/demoAdapters.ts`](./src/demoAdapters.ts) | In-process embedding + vector store for the demo. |
| [`src/printRun.ts`](./src/printRun.ts) | Short transcript dump for the terminal. |

## Production direction

- Swap **`createScriptedSupportLlm`** for **`OpenAILLMAdapter`** (see [`examples/rag`](../rag/) `start:openai` and [`examples/openai-tools-skill`](../openai-tools-skill/)).
- Implement **`contact_support`** `execute` against your ticket system (HTTP, queue, CRM).
- Tighten **`allowedToolIds`** on **`AgentRuntime`** and roles so only trusted agents may ingest or escalate.

See also: [`docs/core/17-rag-pipeline.md`](../../docs/core/17-rag-pipeline.md), [`docs/core/07-definition-syntax.md`](../../docs/core/07-definition-syntax.md) §9.
