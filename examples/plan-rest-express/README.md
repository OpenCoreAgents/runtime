# `plan-rest-express` — REST plugin after `Agent.define`

Uses [`@opencoreagents/rest-api`](../../packages/rest-api/) so you **define agents in code**, then **`app.use(createPlanRestRouter({ … }))`** for **`GET /agents`**, **`POST /agents/:id/run`**, **`resume`**, **`GET /runs/:id`**. This sample uses a **fixed `projectId`**; for **several tenants** on one router, omit **`projectId`** and pass **`X-Project-Id`** / **`?projectId=`** / **`body.projectId`** — see the [package README](../../packages/rest-api/README.md).

## Build

From repo root:

```bash
pnpm turbo run build --filter=@opencoreagents/core --filter=@opencoreagents/rest-api
```

## Run

```bash
pnpm --filter @opencoreagents/example-plan-rest-express start
```

## Try

```bash
curl -s http://127.0.0.1:3050/agents
curl -s -X POST http://127.0.0.1:3050/agents/demo-greeter/run \
  -H 'Content-Type: application/json' \
  -d '{"message":"Say hi"}'
```

Optional: `REST_API_KEY=secret` — then pass `Authorization: Bearer secret` or `X-Api-Key: secret`.

See [`docs/plan-rest.md`](../../docs/plan-rest.md) for the full roadmap (async BullMQ, memory routes, …).
