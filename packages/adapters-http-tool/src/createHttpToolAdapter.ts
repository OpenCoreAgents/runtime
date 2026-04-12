import type { ToolAdapter, ToolContext } from "@opencoreagents/core";
import type { HttpToolConfig } from "./types.js";
import { assertUrlHostAllowed } from "./hostAllowlist.js";
import { resolveTemplate } from "./template.js";

export interface CreateHttpToolAdapterOptions {
  /** Values for `{{secret:NAME}}` in URLs, headers, and body templates. */
  secrets?: Record<string, string>;
}

export function createHttpToolAdapter(
  config: HttpToolConfig,
  options: CreateHttpToolAdapterOptions = {},
): ToolAdapter {
  const secrets = options.secrets ?? {};
  return {
    name: config.id,
    description: config.description,
    async execute(input: unknown, context: ToolContext): Promise<unknown> {
      const { http } = config;
      const resolvedBase = resolveTemplate(http.url, input, context, secrets);
      let finalUrl = resolvedBase;
      if (http.query && Object.keys(http.query).length > 0) {
        const u = new URL(resolvedBase);
        for (const [key, tmpl] of Object.entries(http.query)) {
          u.searchParams.set(key, resolveTemplate(tmpl, input, context, secrets));
        }
        finalUrl = u.toString();
      }

      assertUrlHostAllowed(finalUrl, http.allowedHosts);

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(http.headers ?? {})) {
        headers[key] = resolveTemplate(value, input, context, secrets);
      }

      const method = http.method;
      let body: string | undefined;

      if (method !== "GET" && method !== "DELETE") {
        if (http.bodyFromInput && Object.keys(http.bodyFromInput).length > 0) {
          const obj = Object.fromEntries(
            Object.entries(http.bodyFromInput).map(([key, tmpl]) => [
              key,
              resolveTemplate(tmpl, input, context, secrets),
            ]),
          );
          body = JSON.stringify(obj);
          const hasContentType = Object.keys(headers).some(
            (k) => k.toLowerCase() === "content-type",
          );
          if (!hasContentType) {
            headers["content-type"] = "application/json";
          }
        }
      }

      const res = await fetch(finalUrl, { method, headers, body });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP tool ${config.id}: ${res.status} ${text}`);
      }
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        return res.json() as Promise<unknown>;
      }
      return res.text();
    },
  };
}
