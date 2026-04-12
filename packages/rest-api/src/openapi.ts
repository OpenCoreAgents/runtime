/**
 * OpenAPI 3.0 document for **plan-rest** routes (for Swagger UI / codegen).
 */
export interface PlanRestOpenApiInput {
  /** **`POST` run/resume** enqueue to BullMQ when true. */
  hasDispatch: boolean;
  /** **`GET /runs`** and inline **`resume`** available. */
  hasRunStore: boolean;
  /** Clients must send tenant via header/query/body (no fixed **`projectId`** in router options). */
  multiProject: boolean;
  /** **`apiKey`** option is set on the router. */
  hasApiKey: boolean;
  /** `info.title` (default **Plan REST API**). */
  title?: string;
  /** `info.version` (default **0.0.0**). */
  version?: string;
  /** Extra `info.description` paragraph. */
  description?: string;
}

function securitySchemes(
  hasApiKey: boolean,
): Record<string, Record<string, unknown>> | undefined {
  if (!hasApiKey) return undefined;
  return {
    bearerAuth: {
      type: "http",
      scheme: "bearer",
      description: "Same value as router `apiKey` — `Authorization: Bearer <key>`",
    },
    ApiKeyAuth: {
      type: "apiKey",
      in: "header",
      name: "X-Api-Key",
      description: "Alternative to Bearer — same secret as `apiKey` option",
    },
  };
}

function globalSecurity(
  hasApiKey: boolean,
): Array<Record<string, string[]>> | undefined {
  if (!hasApiKey) return undefined;
  return [{ bearerAuth: [] }, { ApiKeyAuth: [] }];
}

function compactResponses(responses: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(responses)) {
    if (responses[k] === undefined) delete responses[k];
  }
  return responses;
}

/** Build a plain JSON-serializable OpenAPI 3.0 object. */
export function buildPlanRestOpenApiSpec(input: PlanRestOpenApiInput): Record<string, unknown> {
  const {
    hasDispatch,
    hasRunStore,
    multiProject,
    hasApiKey,
    title = "Plan REST API",
    version = "0.0.0",
    description = "",
  } = input;

  const schemes = securitySchemes(hasApiKey);
  const security = globalSecurity(hasApiKey);

  const tenantParams: unknown[] = [];
  if (multiProject) {
    tenantParams.push({
      name: "X-Project-Id",
      in: "header",
      required: false,
      schema: { type: "string" },
      description:
        "Tenant when router has no fixed `projectId`. Also `?projectId=` (GET) or `body.projectId` (POST).",
    });
  }

  const runPostResponses: Record<string, unknown> = {
    "400": { description: "Bad request (e.g. missing message)" },
    "401": hasApiKey ? { description: "Missing or invalid API key" } : undefined,
    "403": { description: "Unknown project (allowlist)" },
    "404": { description: "Unknown agent" },
    "501": hasDispatch
      ? { description: "wait=1 without queueEvents on router" }
      : undefined,
    "502": hasDispatch ? { description: "Job failed in queue" } : undefined,
    "503": hasDispatch ? { description: "Enqueue / queue error" } : undefined,
    "504": hasDispatch ? { description: "waitUntilFinished timeout" } : undefined,
  };
  compactResponses(runPostResponses);

  if (hasDispatch) {
    Object.assign(runPostResponses, {
      "200": {
        description: "Inline-style body when `wait=1` and job completed",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                jobId: { type: "string" },
                sessionId: { type: "string" },
                runId: { type: "string" },
                status: { type: "string" },
                reply: { type: "string" },
              },
            },
          },
        },
      },
      "202": {
        description: "Job accepted — poll `GET /jobs/{jobId}`",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["jobId", "sessionId", "statusUrl"],
              properties: {
                jobId: { type: "string" },
                sessionId: { type: "string" },
                statusUrl: { type: "string" },
                pollUrl: { type: "string" },
              },
            },
          },
        },
      },
    });
  } else {
    Object.assign(runPostResponses, {
      "200": {
        description: "Run finished (or waiting)",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                sessionId: { type: "string" },
                runId: { type: "string" },
                status: { type: "string" },
                reply: { type: "string" },
                resumeHint: { type: "object" },
              },
            },
          },
        },
      },
      "500": { description: "Engine error" },
    });
  }

  const paths: Record<string, unknown> = {
    "/agents": {
      get: {
        summary: "List agents",
        tags: ["Agents"],
        parameters: [...tenantParams],
        responses: compactResponses({
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    projectId: { type: "string" },
                    agents: {
                      type: "array",
                      items: { type: "object", properties: { id: { type: "string" } } },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Missing projectId (multi-tenant mode)" },
          "401": hasApiKey ? { description: "Unauthorized" } : undefined,
        }),
      },
    },
    "/agents/{agentId}/run": {
      post: {
        summary: hasDispatch ? "Run agent (enqueue or wait)" : "Run agent (inline)",
        tags: ["Runs"],
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
          ...(hasDispatch
            ? [
                {
                  name: "wait",
                  in: "query",
                  required: false,
                  schema: { type: "string", enum: ["1", "true"] },
                  description: "Block until worker finishes (needs dispatch.queueEvents)",
                },
              ]
            : []),
          ...tenantParams,
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["message"],
                properties: {
                  message: { type: "string" },
                  sessionId: { type: "string" },
                  ...(multiProject
                    ? {
                        projectId: {
                          type: "string",
                          description: "Tenant for POST when not using header/query",
                        },
                      }
                    : {}),
                  ...(hasDispatch ? { wait: { type: "boolean", description: "Same as ?wait=1" } } : {}),
                },
              },
            },
          },
        },
        responses: runPostResponses,
      },
    },
  };

  const resumeResponses: Record<string, unknown> = compactResponses({
    "400": { description: "Bad request" },
    "401": hasApiKey ? { description: "Unauthorized" } : undefined,
    "404": { description: "Unknown agent" },
    "501": { description: "runStore (inline) or queueEvents (wait)" },
  });
  if (hasDispatch) {
    Object.assign(resumeResponses, {
      "200": { description: "wait=1 completed" },
      "202": { description: "Resume job enqueued" },
      "502": { description: "Job failed" },
      "503": { description: "Enqueue error" },
      "504": { description: "Wait timeout" },
    });
  } else {
    Object.assign(resumeResponses, {
      "200": { description: "OK" },
    });
  }

  paths["/agents/{agentId}/resume"] = {
    post: {
      summary: hasDispatch ? "Resume run (enqueue or wait)" : "Resume run (inline)",
      tags: ["Runs"],
      parameters: [
        { name: "agentId", in: "path", required: true, schema: { type: "string" } },
        ...(hasDispatch
          ? [
              {
                name: "wait",
                in: "query",
                required: false,
                schema: { type: "string", enum: ["1", "true"] },
              },
            ]
          : []),
        ...tenantParams,
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["runId", "sessionId", "resumeInput"],
              properties: {
                runId: { type: "string" },
                sessionId: { type: "string" },
                ...(multiProject ? { projectId: { type: "string" } } : {}),
                ...(hasDispatch ? { wait: { type: "boolean" } } : {}),
                resumeInput: {
                  type: "object",
                  required: ["type", "content"],
                  properties: {
                    type: { type: "string" },
                    content: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
      responses: resumeResponses,
    },
  };

  if (hasRunStore) {
    paths["/runs/{runId}"] = {
      get: {
        summary: "Get run snapshot from RunStore",
        tags: ["Runs"],
        parameters: [
          { name: "runId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "sessionId",
            in: "query",
            required: true,
            schema: { type: "string" },
          },
          ...tenantParams,
        ],
        responses: compactResponses({
          "200": { description: "OK" },
          "400": { description: "Missing sessionId" },
          "401": hasApiKey ? { description: "Unauthorized" } : undefined,
          "403": { description: "sessionId mismatch" },
          "404": { description: "Run not found" },
        }),
      },
    };
  }

  if (hasDispatch) {
    paths["/jobs/{jobId}"] = {
      get: {
        summary: "Poll BullMQ job (returnvalue Run summary when completed)",
        tags: ["Jobs"],
        parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
        responses: compactResponses({
          "200": { description: "Job state + optional run summary" },
          "401": hasApiKey ? { description: "Unauthorized" } : undefined,
          "404": { description: "Job not found" },
        }),
      },
    };
  }

  const doc: Record<string, unknown> = {
    openapi: "3.0.3",
    info: {
      title,
      version,
      description:
        (description ? `${description}\n\n` : "") +
        "Routes match `createPlanRestRouter` from `@opencoreagents/rest-api`. " +
        "Mount the router under a prefix (e.g. `/api`) — paths here are **relative to that mount**.",
    },
    tags: [
      { name: "Agents", description: "Agent listing" },
      { name: "Runs", description: "Run and resume" },
      ...(hasDispatch ? [{ name: "Jobs", description: "BullMQ job polling" }] : []),
    ],
    paths,
  };

  if (schemes) {
    doc.components = { securitySchemes: schemes };
    doc.security = security;
  }

  return doc;
}

/**
 * Minimal Swagger UI page (loads Swagger UI from **unpkg** — no extra npm dependency).
 * `openApiPath` and `uiPath` are the **path segments** on the same router (e.g. `openapi.json`, `docs`).
 */
export function planRestSwaggerUiHtml(openApiPath: string, uiPath: string): string {
  const openFile = JSON.stringify(openApiPath.replace(/^\/+/, ""));
  const uiSeg = JSON.stringify(`/${uiPath.replace(/^\/+/, "").replace(/\/$/, "")}`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Plan REST API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css" crossorigin="anonymous" />
  <style>body { margin: 0; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js" crossorigin="anonymous"></script>
  <script>
    (function () {
      var openFile = ${openFile};
      var uiSegment = ${uiSeg};
      var pathname = window.location.pathname.replace(/\\/$/, "") || "/";
      var base = pathname.endsWith(uiSegment)
        ? pathname.slice(0, pathname.length - uiSegment.length)
        : pathname;
      var url = (base === "" ? "" : base) + "/" + openFile;
      window.ui = SwaggerUIBundle({
        url: url,
        dom_id: "#swagger-ui",
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis],
      });
    })();
  </script>
</body>
</html>`;
}

export interface PlanRestSwaggerPaths {
  openApiPath: string;
  uiPath: string;
}

export interface PlanRestSwaggerOptions {
  openApiPath?: string;
  uiPath?: string;
  /** Overrides OpenAPI `info` */
  info?: { title?: string; version?: string; description?: string };
}

export function normalizePlanRestSwaggerPaths(
  swagger: boolean | PlanRestSwaggerOptions | undefined,
): PlanRestSwaggerPaths | null {
  if (!swagger) return null;
  if (swagger === true) {
    return { openApiPath: "openapi.json", uiPath: "docs" };
  }
  return {
    openApiPath: (swagger.openApiPath ?? "openapi.json").replace(/^\/+/, ""),
    uiPath: (swagger.uiPath ?? "docs").replace(/^\/+/, "").replace(/\/$/, ""),
  };
}

export function planRestSwaggerInfo(
  swagger: boolean | PlanRestSwaggerOptions | undefined,
): PlanRestSwaggerOptions["info"] | undefined {
  if (!swagger || swagger === true) return undefined;
  return swagger.info;
}
