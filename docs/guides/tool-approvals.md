# Tool approvals

Use an execution policy when an agent can propose actions that need an application decision before the tool runs. For example, a support agent can look up an order immediately, while a refund request can wait for an authorized operator.

## Configure the runtime

- `visibilityPolicy` filters the tool catalog shown to the model after the agent's effective allowlist is calculated.
- `executionPolicy` evaluates a prepared, validated tool call before execution. Return `allow` to proceed, `deny` to reject the call, or `wait` to record a pending tool approval.
- Set a `runStore` that implements atomic `claimPendingAction`. The in-memory store supports this for a single process. Use `RedisRunStore` when the run and approval can be handled by different processes.

## Resolve the pending action in your application

1. Read the run using the authenticated caller's scope. When `run.state.pending?.kind === "tool_approval"`, the pending state includes the action ID and expiration.
2. Present the proposed action through your application's approval UI. Authorize the reviewer against the run's project, tenant, and session before accepting a decision.
3. Call `approvePendingAction`, `rejectPendingAction`, or `cancelPendingAction` with the run ID, action ID, and caller-resolved `Session`. The SDK approval API must be wired into your application. A regular `agent.resume()` handles user input and cannot resolve a tool approval.
4. On approval, the SDK checks that the prepared input still matches and evaluates the policy again. The policy must return `allow` at this point. Your application should make the authorized decision available to the policy through trusted application state. Read `executed` before reporting that the action ran.

This example starts after application authentication and authorization:

```ts
import { approvePendingAction } from "@opencoreagents/core";

const pending = run.state.pending;
if (pending?.kind === "tool_approval") {
  const result = await approvePendingAction(runtime, {
    runId: run.runId,
    actionId: pending.actionId,
    session,
  });

  console.log(result.executed ? "Tool executed" : "Tool did not execute");
}
```

Run events can power an approval UI or audit log. Configure `eventSinks` and a `redactor` on the runtime when you need to deliver events outside the process.

- [Engine configuration](../../packages/core/src/runtime/engineConfig.ts)
- [Approval API](../../packages/core/src/engine/approvalApi.ts)
- [Approval tests](../../packages/core/tests/approvalApi.test.ts)
- [Scope and security](../reference/core/11-scope-and-security.md)
