import { Agent } from "../define/Agent.js";
import { Session } from "../define/Session.js";
import { EngineJobExpiredError } from "../errors/index.js";
import type { Run } from "../protocol/types.js";
import type { AgentRuntime } from "../runtime/AgentRuntime.js";
import type { EngineJobPayload } from "./engineJobPayload.js";

function throwIfJobExpired(payload: EngineJobPayload): void {
  const deadline = payload.expiresAtMs;
  if (deadline != null && Number.isFinite(deadline) && Date.now() > deadline) {
    throw new EngineJobExpiredError("Engine job expired (expiresAtMs)");
  }
}

/**
 * Loads the agent and executes **`run`**, **`resume`**, or **`continue`** for a validated {@link EngineJobPayload}.
 * Prefer **`runtime.dispatch(payload)`** when you already hold an {@link AgentRuntime}.
 *
 * **Dynamic definitions:** when **`runtime.config.dynamicDefinitionsStore`** is set, this helper awaits
 * **`hydrateAgentDefinitionsFromStore`** (from **`@opencoreagents/dynamic-definitions`**, loaded at runtime)
 * before **`Agent.load`**, using **`payload.projectId`** / **`payload.agentId`** and optional
 * **`runtime.config.dynamicDefinitionsSecrets`**. When the store is omitted, behavior matches code-only agents.
 */
export async function dispatchEngineJob(
  runtime: AgentRuntime,
  payload: EngineJobPayload,
): Promise<Run> {
  throwIfJobExpired(payload);
  const store = runtime.config.dynamicDefinitionsStore;
  if (store != null) {
    const { hydrateAgentDefinitionsFromStore } = (await import(
      /* Optional: install `@opencoreagents/dynamic-definitions` when using `dynamicDefinitionsStore`. */
      "@opencoreagents/dynamic-definitions"
    )) as {
      hydrateAgentDefinitionsFromStore: (
        store: unknown,
        projectId: string,
        agentId: string,
        options?: { secrets?: Record<string, string> },
      ) => Promise<void>;
    };
    const methods =
      typeof store === "object" &&
      store !== null &&
      "methods" in store &&
      (store as { methods: unknown }).methods != null &&
      typeof (store as { methods: unknown }).methods === "object"
        ? (store as { methods: unknown }).methods
        : store;
    await hydrateAgentDefinitionsFromStore(methods, payload.projectId, payload.agentId, {
      secrets: runtime.config.dynamicDefinitionsSecrets?.() ?? {},
    });
  }
  const session = new Session({
    id: payload.sessionId,
    projectId: payload.projectId,
    tenantId: payload.tenantId,
    endUserId: payload.endUserId,
    sessionContext: payload.sessionContext,
    expiresAtMs: payload.expiresAtMs,
    fileReadRoot: payload.fileReadRoot,
    allowFileReadOutsideRoot: payload.allowFileReadOutsideRoot,
    allowHttpFileSources: payload.allowHttpFileSources,
    httpFileSourceHostsAllowlist: payload.httpFileSourceHostsAllowlist,
  });
  const agent = await Agent.load(payload.agentId, runtime, { session });
  if (payload.kind === "run") {
    const rid = payload.runId;
    return await agent.run(
      payload.userInput,
      rid !== undefined && rid !== "" ? { runId: rid } : undefined,
    );
  }
  if (payload.kind === "continue") {
    return await agent.continueRun(payload.runId, payload.userInput);
  }
  return await agent.resume(payload.runId, payload.resumeInput);
}
