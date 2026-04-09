import type { Run } from "@agent-runtime/core";

export function printRunSummary(run: Run): void {
  console.log("status:", run.status);
  for (const h of run.history) {
    if (h.type === "action") {
      const c = h.content as { tool?: string; input?: unknown };
      console.log("action:", c.tool, JSON.stringify(c.input));
    } else if (h.type === "observation") {
      const o = h.content as Record<string, unknown>;
      if (Array.isArray(o.results)) {
        console.log(
          "observation: system_vector_search hits:",
          o.results.length,
          "top score:",
          (o.results[0] as { score?: number } | undefined)?.score,
        );
      } else if (o.ticketId != null) {
        console.log(
          "observation: contact_support ticketId:",
          o.ticketId,
          "email:",
          o.customerEmail ?? "(none)",
        );
      } else if (Array.isArray((o as { data?: unknown }).data)) {
        console.log(
          "observation: system_get_memory working rows:",
          (o as { data: unknown[] }).data.length,
          JSON.stringify(o).slice(0, 400),
        );
      } else {
        console.log("observation:", JSON.stringify(o).slice(0, 500));
      }
    } else if (h.type === "wait") {
      const c = h.content as { reason?: string };
      console.log("wait:", c.reason ?? "");
    } else if (h.type === "result") {
      console.log("result:", h.content);
    }
  }
}
