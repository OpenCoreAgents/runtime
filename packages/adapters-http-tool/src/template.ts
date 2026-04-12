import type { ToolContext } from "@opencoreagents/core";

const SECRET = /\{\{secret:([a-zA-Z0-9_]+)\}\}/g;
const CONTEXT = /\{\{context\.([a-zA-Z0-9_]+)\}\}/g;
const INPUT = /\{\{input\.([a-zA-Z0-9_]+)\}\}/g;

function readInputPath(input: unknown, key: string): string {
  if (input === null || input === undefined || typeof input !== "object") {
    return "";
  }
  const v = (input as Record<string, unknown>)[key];
  return v === undefined || v === null ? "" : String(v);
}

function readContextPath(context: ToolContext, key: string): string {
  const v = (context as unknown as Record<string, unknown>)[key];
  return v === undefined || v === null ? "" : String(v);
}

/**
 * Replaces `{{secret:NAME}}`, `{{context.key}}`, `{{input.key}}`.
 * Unknown secret names throw so misconfiguration fails fast.
 */
export function resolveTemplate(
  template: string,
  input: unknown,
  context: ToolContext,
  secrets: Record<string, string>,
): string {
  let out = template.replace(SECRET, (_, name: string) => {
    const v = secrets[name];
    if (v === undefined) {
      throw new Error(`Missing secret for template: ${name}`);
    }
    return v;
  });
  out = out.replace(CONTEXT, (_, key: string) => readContextPath(context, key));
  out = out.replace(INPUT, (_, key: string) => readInputPath(input, key));
  return out;
}
