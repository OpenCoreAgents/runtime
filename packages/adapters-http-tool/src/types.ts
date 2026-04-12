import type { ToolDefinition } from "@opencoreagents/core";

export type HttpToolMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpToolTransport {
  method: HttpToolMethod;
  /**
   * Absolute URL; may include `{{input.*}}`, `{{context.*}}`, `{{secret:NAME}}`.
   * If the host can change from untrusted input, set an explicit `allowedHosts` allowlist (SSRF).
   */
  url: string;
  /**
   * Allowed hostnames for the resolved URL (no port — use hostname only).
   * If omitted or empty, defaults to the hostname of the resolved `url`.
   */
  allowedHosts?: string[];
  headers?: Record<string, string>;
  /** Appended as query string (GET or any method). Values are template strings. */
  query?: Record<string, string>;
  /** For methods with a body: JSON object built from template strings per key. */
  bodyFromInput?: Record<string, string>;
}

/** Serializable tool definition plus HTTP transport; register with {@link registerHttpToolsFromDefinitions}. */
export type HttpToolConfig = ToolDefinition & { http: HttpToolTransport };
