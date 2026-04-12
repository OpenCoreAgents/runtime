# HTTP-configured tools (`@opencoreagents/adapters-http-tool`)

Related: [05-adapters.md](./05-adapters.md) (`ToolAdapter`, `ToolRunner`), [07-definition-syntax.md](./07-definition-syntax.md) (`Tool.define`), [08-scope-and-security.md](./08-scope-and-security.md) (SSRF, outbound calls), [21-dynamic-runtime-rest.md](./21-dynamic-runtime-rest.md) (REST + store + sync).

The package **`@opencoreagents/adapters-http-tool`** registers tools whose behavior is described by **JSON-serializable config**: URL, method, optional query/body maps, headers, and optional host allowlisting. At runtime it uses a **single generic** `fetch`-based implementation — no per-tool `execute` function in application code.

The core exposes **`registerToolHandler`** and **`registerToolDefinition`** so apps (or this package) can separate **schema** (`Tool.define` without `execute`) from **implementation** (handler registration).

---

## 1. Why use it

- **Dynamic catalogs**: load tool definitions from a database or file; hydrate the process without shipping new TypeScript per integration.
- **Serverless-friendly**: same worker bundle; new tools are config rows, not redeploys (as long as secrets and allowlists are managed safely).
- **Alignment with the engine**: the LLM still sees normal tool names and JSON Schemas; **`ToolRunner`** invokes the same `ToolAdapter` contract as built-in tools.

---

## 2. Config shape: `HttpToolConfig`

Each entry is a **`ToolDefinition`** (e.g. `id`, `projectId`, `description`, `inputSchema`) plus an **`http`** object:

| Field | Purpose |
|--------|---------|
| **`http.method`** | `GET` \| `POST` \| `PUT` \| `PATCH` \| `DELETE` |
| **`http.url`** | Absolute URL; may contain templates (see §4). |
| **`http.allowedHosts`** | Optional list of allowed **hostnames** (no port). See §5. |
| **`http.headers`** | Optional header map; values may be templates. |
| **`http.query`** | Optional map for query parameters (merged into the URL); values may be templates. Used with any method; typical for `GET`. |
| **`http.bodyFromInput`** | For methods with a body (`POST`, `PUT`, `PATCH`): object whose values are templates; serialized as JSON. `content-type: application/json` is set if missing. |

---

## 3. Registration API

### `registerHttpToolsFromDefinitions(configs, options?)`

For each `HttpToolConfig`:

1. Calls **`Tool.define`** with the tool metadata **only** (the `http` block is stripped — it is not part of the persisted `ToolDefinition` in the registry).
2. Calls **`registerToolHandler`** with an adapter produced from that config.

Optional **`options.secrets`**: map of names to string values for **`{{secret:NAME}}`** templates (see §4). Prefer loading secrets from env or a secret manager and passing them here — do not store raw secrets inside tool JSON persisted to untrusted stores.

### `createHttpToolAdapter(config, options?)`

Returns a single **`ToolAdapter`** if you prefer to register manually (e.g. conditional registration, tests).

### `resolveTemplate`, `resolveAllowedHostnames`, `assertUrlHostAllowed`

Low-level helpers for custom tooling or tests.

---

## 4. Template syntax

In **`http.url`**, **`http.headers`**, **`http.query`** values, and **`http.bodyFromInput`** values:

| Pattern | Replacement |
|---------|-------------|
| `{{input.<key>}}` | Top-level property of the tool **input** object (stringified; missing → empty string). |
| `{{context.<key>}}` | Property on **`ToolContext`** (e.g. `projectId`, `runId`, `sessionId`, `agentId`, `endUserId`). |
| `{{secret:NAME}}` | **`options.secrets[NAME]`**; throws if missing. |

Secrets are resolved first, then context, then input.

---

## 5. Host allowlisting (`allowedHosts`)

- If **`http.allowedHosts`** is **omitted or empty**, the effective allowlist defaults to **the hostname of the resolved URL** (after templates are applied). That matches a fixed integration URL and avoids duplicating the host in config.
- If **`http.allowedHosts`** is a **non-empty** array, the resolved URL’s **hostname** must appear in that list; otherwise **execution** throws before `fetch`.

**SSRF note:** If **`http.url`** (or any part of the final URL) can change based on **untrusted input** (e.g. `{{input.host}}`), the default allowlist will accept whatever host the input points to. In those cases you **must** set an explicit **`allowedHosts`** to a fixed set of trusted hostnames, or avoid templating the host entirely.

---

## 6. Response handling

- If the response **`Content-Type`** contains **`application/json`**, the body is parsed with **`res.json()`** and returned as the tool result.
- Otherwise the **text** body is returned.

Non-OK HTTP status: throws an error including status and response text.

---

## 7. Example: JSON catalog + bootstrap

```typescript
import { registerHttpToolsFromDefinitions } from "@opencoreagents/adapters-http-tool";
import type { HttpToolConfig } from "@opencoreagents/adapters-http-tool";

const catalog: HttpToolConfig[] = [
  {
    id: "crm_customer_lookup",
    projectId: "acme",
    description: "Look up a customer by email.",
    inputSchema: {
      type: "object",
      properties: { email: { type: "string", format: "email" } },
      required: ["email"],
    },
    http: {
      method: "POST",
      url: "https://crm.example.com/v1/lookup",
      headers: {
        authorization: "Bearer {{secret:CRM_API_KEY}}",
        "x-project-id": "{{context.projectId}}",
      },
      bodyFromInput: { email: "{{input.email}}" },
    },
  },
];

await registerHttpToolsFromDefinitions(catalog, {
  secrets: { CRM_API_KEY: process.env.CRM_API_KEY! },
});
```

After this, any agent with **`tools: ["crm_customer_lookup"]`** (and your usual **`AgentRuntime`** / **`Agent.load`**) will execute the remote call through **`ToolRunner`**, subject to **`toolTimeoutMs`** on the runtime.

---

## 8. Comparison with `Tool.define({ …, execute })`

| Approach | Config | Handler |
|----------|--------|---------|
| **Inline `execute`** | `ToolDefinition` + function in code | Same call to `Tool.define` |
| **`adapters-http-tool`** | `HttpToolConfig` (JSON) | `registerHttpToolsFromDefinitions` or `createHttpToolAdapter` |

Both end up as named entries in the same in-process **`ToolAdapter`** map; **`ContextBuilder`** still builds the LLM tool list from definitions + registry.

---

## 9. Operational notes

- **Redirects:** Uses default **`fetch`** redirect behavior; if you need to block cross-host redirects, configure that at the fetch layer (future extension) or use a private integration URL that does not redirect off-host.
- **Clustering:** Definitions and handlers are **per process**, like other `Tool.define` / `registerToolHandler` usage ([19-cluster-deployment.md](./19-cluster-deployment.md)): every worker must run the same bootstrap (or load the same catalog) before executing runs.
