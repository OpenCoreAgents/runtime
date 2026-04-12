import type { Run } from "@opencoreagents/core";

/** Narrow full Run history to a small JSON shape for HTTP responses and job.returnvalue polling. */
export function summarizeRun(run: Run): {
  status: Run["status"];
  runId: string;
  reply: string | undefined;
} {
  const result = run.history.filter((h) => h.type === "result").pop();
  return {
    status: run.status,
    runId: run.runId,
    reply: result && typeof result.content === "string" ? result.content : undefined,
  };
}
