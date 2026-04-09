import type { Server } from "node:http";

const DEFAULT_MS = 10_000;

/**
 * Stops accepting new connections; waits for in-flight HTTP handlers to finish.
 * Does **not** cancel in-flight `agent.run()` — for that you’d pass `AbortSignal` from a request-scoped controller (product code).
 */
export function registerGracefulShutdown(
  server: Server,
  options?: { timeoutMs?: number },
): void {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_MS;

  const close = (signal: NodeJS.Signals) => {
    console.log(`[shutdown] ${signal} — closing HTTP server (no new requests)`);
    server.close((err) => {
      if (err) {
        console.error("[shutdown] close error", err);
        process.exit(1);
        return;
      }
      console.log("[shutdown] HTTP server closed");
      process.exit(0);
    });

    const t = setTimeout(() => {
      console.error(`[shutdown] timeout ${timeoutMs}ms — exiting`);
      process.exit(1);
    }, timeoutMs);
    t.unref();
  };

  process.once("SIGINT", () => close("SIGINT"));
  process.once("SIGTERM", () => close("SIGTERM"));
}
