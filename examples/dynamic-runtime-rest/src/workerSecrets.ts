/**
 * HTTP tool `{{secret:*}}` values for `hydrateAgentDefinitionsFromStore` — **worker env only**.
 * Do not put secrets in BullMQ job payloads (they are stored in Redis).
 */
export function httpToolSecretsFromEnv(): Record<string, string> {
  const raw = process.env.HTTP_TOOL_SECRETS_JSON;
  if (!raw?.trim()) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    if (typeof o !== "object" || o === null || Array.isArray(o)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}
