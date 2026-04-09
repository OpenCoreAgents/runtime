/**
 * Minimal **Server-Sent Events** helpers for streaming run hooks to the client.
 * Clients should use `fetch()` + `ReadableStream` (or `curl -N`); `EventSource` only supports GET.
 */
import type { Response } from "express";

export function initSse(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  const r = res as Response & { flushHeaders?: () => void };
  r.flushHeaders?.();
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: "non-serializable payload" });
  }
}

/** One SSE message: `event` name + single `data:` line (JSON). */
export function sendSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${safeStringify(data)}\n\n`);
}
