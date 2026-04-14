/**
 * Merges Redis definition admin routes (`/v1/...`) into the plan REST OpenAPI document
 * so `GET /docs` documents the full HTTP surface.
 */

function jsonErr(description: string): Record<string, unknown> {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/RuntimeRestJsonError" },
      },
    },
  };
}

const looseJsonBody: Record<string, unknown> = {
  required: true,
  content: {
    "application/json": {
      schema: {
        type: "object",
        additionalProperties: true,
        description:
          "Persisted shape for the resource (`AgentDefinitionPersisted`, `SkillDefinitionPersisted`, or HTTP tool config). Optional `body.id` must match the path id. HTTP tools: optional `_secrets` object (string values) is stored separately and omitted from `GET /v1/definitions`.",
      },
    },
  },
};

export function extendOpenApiWithDefinitionsAdmin(
  spec: Record<string, unknown>,
): Record<string, unknown> {
  const paths = { ...((spec.paths as Record<string, unknown>) ?? {}) };
  const tags = [...((spec.tags as Array<Record<string, unknown>>) ?? [])];

  tags.push({
    name: "Definitions (Redis)",
    description:
      "Read/write/delete agent, skill, and HTTP tool definitions. Mounted at `/v1` on the runtime app; same `REST_API_KEY` as plan REST when set.",
  });

  paths["/v1/definitions"] = {
    get: {
      summary: "Snapshot of project definitions",
      description:
        "Returns agents, skills, and HTTP tools for the configured project. `_secrets` are stripped from HTTP tools.",
      tags: ["Definitions (Redis)"],
      responses: {
        "200": {
          description: "OK — `ProjectDefinitionsSnapshot`",
          content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
        },
        "401": jsonErr("Missing or invalid API key"),
        "500": jsonErr("Store or server error"),
      },
    },
  };

  for (const [pathSuffix, param, label, summary, extraDesc] of [
    ["/v1/http-tools/{toolId}", "toolId", "toolId", "Upsert HTTP tool", ""] as const,
    ["/v1/skills/{skillId}", "skillId", "skillId", "Upsert skill", ""] as const,
    [
      "/v1/agents/{agentId}",
      "agentId",
      "agentId",
      "Upsert agent",
      " Agent ids **`planner`** and **`chat`** are reserved (runtime defaults). Other ids must not start with `system_` or equal a built-in / planner / RAG **tool** id (e.g. `invoke_planner`, `system_save_memory`).",
    ] as const,
  ]) {
    const putOp: Record<string, unknown> = {
      summary,
      description: `If \`body.id\` is set, it must equal path :${label}.${extraDesc}`,
      tags: ["Definitions (Redis)"],
      parameters: [{ name: param, in: "path", required: true, schema: { type: "string" } }],
      requestBody: looseJsonBody,
      responses: {
        "200": {
          description: "OK",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok", "id"],
                properties: { ok: { type: "boolean", enum: [true] }, id: { type: "string" } },
              },
            },
          },
        },
        "400": jsonErr("Validation, id mismatch, or store error"),
        "401": jsonErr("Missing or invalid API key"),
      },
    };

    const entry: Record<string, unknown> = { put: putOp };

    if (pathSuffix === "/v1/http-tools/{toolId}") {
      entry.delete = {
        summary: "Delete HTTP tool",
        description: "Removes the tool row from Redis and drops its in-process handler on the API process.",
        tags: ["Definitions (Redis)"],
        parameters: [{ name: "toolId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ok", "id"],
                  properties: { ok: { type: "boolean", enum: [true] }, id: { type: "string" } },
                },
              },
            },
          },
          "400": jsonErr("Invalid path id, reserved tool id, or id starting with system_"),
          "401": jsonErr("Missing or invalid API key"),
          "404": jsonErr("Tool not found in store"),
        },
      };
    }

    if (pathSuffix === "/v1/skills/{skillId}") {
      entry.delete = {
        summary: "Delete skill",
        description: "Removes the skill row from Redis and drops it from the in-process registry on the API process.",
        tags: ["Definitions (Redis)"],
        parameters: [{ name: "skillId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ok", "id"],
                  properties: { ok: { type: "boolean", enum: [true] }, id: { type: "string" } },
                },
              },
            },
          },
          "400": jsonErr("Invalid path id"),
          "401": jsonErr("Missing or invalid API key"),
          "404": jsonErr("Skill not found in store"),
        },
      };
    }

    paths[pathSuffix] = entry;
  }

  const info = { ...((spec.info as Record<string, unknown>) ?? {}) };
  const baseDesc = String(info.description ?? "");
  if (!baseDesc.includes("/v1/definitions")) {
    info.description =
      baseDesc +
      (baseDesc.trim() ? "\n\n" : "") +
      "Definitions admin: see tag **Definitions (Redis)** (`/v1/definitions`, `PUT /v1/agents/{agentId}`, …).";
  }

  return { ...spec, paths, tags, info };
}
