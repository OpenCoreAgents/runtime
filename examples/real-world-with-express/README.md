# real-world-with-express

**Express** server that wires **`AgentRuntime`** once per process and exposes JSON routes:

- **`POST /v1/chat`** — `Agent.load` + **`run(message)`** (optional **`OPENAI_API_KEY`**, otherwise a deterministic mock).
- **`POST /v1/chat/stream`** — same body, **`text/event-stream`** (SSE): **`step`** (thought/action), **`observation`**, then **`done`** with `reply` (hooks from **`RunBuilder`** — not token streaming from the LLM).
- **`GET /status`** — process uptime, PID, Node version (public, like **`/health`**).
- **`GET /v1/runs/:runId?sessionId=`** — read persisted run state from **`RunStore`** (poll after **`wait`** or inspect completed runs).
- **`GET /v1/sessions/:sessionId/status`** — list all persisted runs for that **`sessionId`** (chat + wait-demo agents) plus **`summary.byStatus`** counts.
- **`POST /v1/runs/wait-demo`** + **`POST /v1/runs/:runId/resume`** — same **`InMemoryRunStore`** pattern as [`rag-contact-support`](../rag-contact-support/), but the “host” is HTTP instead of stdin.

**Host-layer behavior (typical BFF):** **`X-Request-Id`**, minimal **security headers**, **CORS** (reflecting `Origin` for dev), optional **`API_KEY`** bearer auth on **`/v1/*`** (`/health` stays unauthenticated for probes), **404** JSON, **graceful shutdown** on SIGINT/SIGTERM. See [`src/middleware.ts`](./src/middleware.ts) and [`src/shutdown.ts`](./src/shutdown.ts).

Still **not** full production: no per-tenant authZ, no rate limits, **`InMemoryRunStore`** is single-process — see [`docs/core/08-scope-and-security.md`](../../docs/core/08-scope-and-security.md) and [`docs/core/14-consumers.md`](../../docs/core/14-consumers.md). For multiple workers, use **`RedisRunStore`** and align sessions ([`docs/core/19-cluster-deployment.md`](../../docs/core/19-cluster-deployment.md)).

## Setup

From the repository root:

```bash
pnpm install
pnpm turbo run build --filter=@agent-runtime/core --filter=@agent-runtime/adapters-openai
```

Optional: copy [`.env.example`](./.env.example) to `.env`. Set **`OPENAI_API_KEY`** for real chat; set **`API_KEY`** to require `Authorization: Bearer …` on **`/v1/*`**.

## Run

```bash
pnpm --filter @agent-runtime/example-real-world-with-express start
```

Default URL: `http://127.0.0.1:3000` (override with **`PORT`**).

## Try it

**Health**

```bash
curl -s http://127.0.0.1:3000/health | jq .
```

**Status** (uptime, PID, Node version — same auth model as `/health`: no `API_KEY`)

```bash
curl -s http://127.0.0.1:3000/status | jq .
```

**Run status** (persisted runs only — e.g. after **`wait`** or any completed run the engine saved; requires **`sessionId`**)

```bash
curl -s "http://127.0.0.1:3000/v1/runs/$RUN_ID?sessionId=$SESSION" | jq .
```

**Session status** (all runs in **`RunStore`** for that session — useful after **`wait-demo`** + **`chat`**)

```bash
curl -s "http://127.0.0.1:3000/v1/sessions/$SESSION/status" | jq .
```

**Chat** (mock LLM if no OpenAI key)

```bash
curl -s -X POST http://127.0.0.1:3000/v1/chat \
  -H 'Content-Type: application/json' \
  -H 'X-Request-Id: demo-1' \
  -d '{"message":"Hello"}' | jq .
```

**Chat SSE** (`-N` disables buffering so events appear as they are written)

```bash
curl -N -s -X POST http://127.0.0.1:3000/v1/chat/stream \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"message":"Hello"}'
```

With **`API_KEY=secret`** in the environment:

```bash
curl -s -X POST http://127.0.0.1:3000/v1/chat \
  -H 'Authorization: Bearer secret' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hello"}' | jq .
```

**Wait / resume** (scripted LLM — no OpenAI needed)

```bash
SESSION=$(uuidgen)
curl -s -X POST http://127.0.0.1:3000/v1/runs/wait-demo \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SESSION\"}" | tee /tmp/w.json | jq .

RUN=$(jq -r .runId /tmp/w.json)
curl -s -X POST "http://127.0.0.1:3000/v1/runs/$RUN/resume" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SESSION\",\"text\":\"Alex\"}" | jq .
```

The composite LLM in [`src/llm.ts`](./src/llm.ts) routes by markers in the agent **`systemPrompt`** (`EXPRESS_TAG_CHAT` / `EXPRESS_TAG_WAIT`) — a demo trick; in your app you normally use **one** provider per runtime or a single custom router with explicit config.

**Shutdown:** send SIGINT (Ctrl+C) or SIGTERM — the server stops accepting new connections; in-flight request handlers run to completion. Long **`agent.run()`** calls are **not** aborted (you would wire **`AbortSignal`** from a product-specific controller).

## Typecheck

```bash
pnpm --filter @agent-runtime/example-real-world-with-express run typecheck
```
