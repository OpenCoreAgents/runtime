# agent-runtime (monorepo)

Stateful agent **engine** for Node.js: typed loop (`thought` → `action` → `observation` → `result` / `wait` / `resume`), pluggable adapters, RAG tools, multi-agent messaging, CLI/scaffold.

## Packages

| Package | Role |
|---------|------|
| `@agent-runtime/core` | Engine, `Tool` / `Skill` / `Agent`, `RunBuilder`, `executeRun`, built-in tools |
| `@agent-runtime/adapters-openai` | OpenAI LLM + embeddings |
| `@agent-runtime/adapters-redis` | TCP Redis: memory, `RunStore`, `MessageBus` |
| `@agent-runtime/adapters-upstash` | Upstash REST Redis + vector |
| `@agent-runtime/adapters-bullmq` | **BullMQ** queue/worker + `dispatchEngineJob` |
| `@agent-runtime/utils` | Parsers, chunking, file resolver |
| `@agent-runtime/rag` | File/RAG tools + skills |
| `@agent-runtime/scaffold` | Programmatic project generation |
| `@agent-runtime/cli` | `agent-runtime` CLI |

## Examples

- **Minimal `Agent.run()`:** [`examples/minimal-run`](examples/minimal-run/) — mock LLM + in-memory memory, no API keys (build `@agent-runtime/core` first).
- **OpenAI + tool + skill:** [`examples/openai-tools-skill`](examples/openai-tools-skill/) — `OpenAILLMAdapter`, custom `roll_dice` tool, `dice-skill`, one run (requires `OPENAI_API_KEY`; build `core` + `adapters-openai`).
- **Console `wait` + user input:** [`examples/console-wait`](examples/console-wait/) — mock LLM pauses, `onWait` reads a line from the terminal (build `core` first).

## Docs

- **Product / overview:** [`docs/README.md`](docs/README.md)
- **Engine reference:** [`docs/core/README.md`](docs/core/README.md)
- **Implementation plan:** [`docs/plan.md`](docs/plan.md)
- **Monorepo layout & types:** [`docs/scaffold.md`](docs/scaffold.md)

## Develop

```bash
pnpm install
pnpm turbo run build test lint
```

CI runs the same via [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## License

Private / TBD — see repository settings.
