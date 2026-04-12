import type { Run } from "@opencoreagents/core";

/** Narrow full **`Run`** history for job **`returnvalue`** and HTTP responses. */
export function summarizeEngineRun(run: Run): {
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
