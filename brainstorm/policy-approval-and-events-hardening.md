# Policy, Approval, and Events Hardening

## Status

Ready for staged implementation. This is a product-aligned implementation proposal, not a verbatim copy of the external requirements that motivated it.

The goal is to adapt the request to OpenCore Agents as it exists today: a small core execution engine with agent and skill allowlists, `ToolRunner`, `RunStore`, browser adapters, runtime hooks, and host-owned production boundaries.

## Current Baseline

OpenCore Agents already has several of the primitives needed for this work:

- Agent, skill, and runtime tool allowlists are intersected when engine dependencies are built.
- `ToolRunner` rejects tool execution when a tool is outside the effective allowlist.
- `SecurityContext` exists and is passed into `ToolContext`.
- `wait` and `resume` are first-class run lifecycle states.
- `RunStore.saveIfStatus` gives bundled stores a compare-and-swap primitive for waiting-run resumes.
- Runtime hooks and Redis run-event publishing exist for internal observability.
- Browser persistence exists through IndexedDB adapters.

The missing layer is a generic host-policy and approval boundary that works consistently across server, worker, browser, and REST use cases.

## Design Direction

Implement this as an incremental hardening layer around existing engine seams instead of replacing the execution model.

The engine should keep the same protocol shape: LLM output becomes `thought`, `action`, `wait`, or `result`. The new features should strengthen how `action` is prepared, authorized, delayed, executed, emitted, and persisted.

The implementation should preserve backward compatibility for existing tools and runtimes unless a host explicitly opts into new policy behavior.

## Project Fit

This proposal should respect the current package boundaries:

- `@opencoreagents/core` owns the execution loop, protocol types, tool contracts, `RunStore`, and runtime configuration seams.
- REST, Redis SSE, BullMQ, and chat routes should adapt core primitives instead of defining their own approval model.
- Browser-specific recovery and IndexedDB behavior should stay in `@opencoreagents/browser`.
- Host authentication remains outside core. Core can provide policy hooks and helpers, but it should not become an auth server or identity provider.
- Internal `EngineHooks` should remain a low-level observer API. Public events should be a separate, stable projection.

The main architectural change should be a tool-action pipeline inside the engine:

```text
model action
  -> resolve allowed tool
  -> enforce effective allowlist
  -> prepare canonical input
  -> emit/record tool proposed
  -> execution policy decision
  -> allow: execute tool and append observation
  -> deny: append safe failure observation
  -> wait: persist pending tool action and return waiting run
```

`ToolRunner` can still own low-level validation, timeout, and execution. The engine action path must own decisions that affect `Run` state, such as policy-driven `waiting`.

Visibility and execution authorization should be designed together even if they land in separate PRs. Visibility decides what the model can see. Execution policy decides whether a prepared action may run. They should share compatible inputs so hosts do not need two unrelated policy systems.

## What We Should Implement

### 1. Canonical Tool Input

Add `prepareInput` to `ToolAdapter`.

This should be the first implementation step because later policy, approvals, input hashing, event payloads, and audit records all need one canonical input value.

Proposed behavior:

- Resolve the tool and enforce the effective allowlist before preparation. Do not prepare input for a tool that is unknown or outside the allowed surface.
- If `prepareInput` exists, call it exactly once per proposed tool action.
- Use the returned prepared value for execution policy, approval state, hashing, events, and `tool.execute`.
- If `prepareInput` does not exist, keep the current `validate` behavior.
- Failed preparation should produce a safe tool failure observation and never execute the tool.

This is a small extension of the existing `ToolRunner` path, not a protocol redesign.

The engine needs access to the prepared value before execution. Do not hide preparation inside a single `ToolRunner.execute(name, rawInput, context)` method. Prefer a split API such as:

```ts
toolRunner.prepare(name, rawInput);
toolRunner.executePrepared(name, preparedInput, context);
```

The exact names can change, but the boundary matters: policy, pending action persistence, input hashing, public events, and `tool.execute` must all see the same prepared value.

Use a stable preparation result shape so the first implementation PR does not invent a throwaway mini-contract:

```ts
type PreparedToolAction =
  | {
      ok: true;
      tool: ToolAdapter;
      toolName: string;
      rawInput: unknown;
      preparedInput: unknown;
    }
  | {
      ok: false;
      toolName: string;
      reason: string;
    };
```

### 2. Pre-Tool Execution Policy

Add an optional runtime-level policy hook that runs after input preparation and validation, but before `tool.execute`.

The policy should return:

- `allow`: execute the tool.
- `deny`: do not execute the tool; append a safe structured observation.
- `wait`: do not execute the tool; persist a pending approval action and set the run to `waiting`.

This should be generic and apply to all tools, not just system tools.

Initial implementation should be wired through the engine action path, with helper methods on `ToolRunner` if needed. A `wait` decision must not be hidden inside `ToolRunner`, because it needs access to the current `Run`, `RunStore`, event sinks, and persistence semantics.

The hook should be configured on `AgentRuntime` / `EngineConfig`, then copied into `EngineDeps` by `buildEngineDeps`, matching existing patterns such as `defaultEngineHooks`, `allowedToolIds`, and `sendMessageTargetPolicy`.

### 3. Tool Visibility Policy

Add a host-provided visibility policy near the execution policy work, not after the entire approval system. Visibility and execution authorization are two sides of the same safety boundary and should have compatible input types.

The visibility policy should filter the already-effective candidate tool set. It must never add tools outside the agent, skill, and runtime allowlists.

This should be wired into context building so hidden tools are not sent to the LLM. `ToolRunner` still needs the execution-side check so malformed model output cannot bypass visibility.

The candidate set should come from the same effective allowlist path used today: agent tools plus skill tools, intersected with runtime `allowedToolIds`, then resolved against the project registry. The visibility policy only subtracts from that set.

### 4. Policy-Driven Pending Actions

Extend run state to represent a pending tool action created by execution policy.

The current `run.state.pending = { reason, details }` is enough for model-driven waits, but not enough for approval of a specific tool side effect.

Make pending state discriminated from the beginning:

```ts
type RunPending =
  | {
      kind: "model_wait";
      reason: string;
      details?: unknown;
    }
  | {
      kind: "tool_approval";
      actionId: string;
      toolName: string;
      preparedInput: unknown;
      inputHash: string;
      reason: string;
      details?: unknown;
      policyVersion?: string;
      createdAt: string;
      expiresAt?: string;
    };
```

The tool-approval shape should include:

- `actionId`
- `toolName`
- `preparedInput`
- `inputHash`
- `reason`
- `details`
- `policyVersion`
- `createdAt`
- `expiresAt`

This should live under `run.state.pending` because current docs and adapters already treat `pending` as the waiting-run snapshot.

If `preparedInput` is not safe or practical to persist directly, the host should be able to store an opaque protected reference instead. This matters for large payloads, local paths, signed URLs, secrets, PII, or inputs whose retention policy differs from normal run state. The approval path must still execute the exact prepared action represented by that reference.

Policy-driven tool approval should require a `RunStore` by default. Without durable persistence, a pending approval can be lost across workers, process restarts, browser reloads, or queue handoff. Hosts that explicitly want ephemeral in-process approvals can opt into that weaker mode, but the default should fail fast with a clear error when a policy returns `wait` and no approval-capable store is configured.

### 5. Action-Level Claiming and Idempotency

`saveIfStatus(run, "waiting")` is useful but too broad for pending-action approval.

Add a narrower claim mechanism that atomically moves:

```text
waiting + pending(actionId) -> running + claimed(actionId)
```

The claim should produce or preserve a stable idempotency key based on `runId + actionId`, then pass that key to `ToolContext`.

This protects OpenCore's boundary from duplicate approvals. It cannot guarantee exactly-once behavior inside every external service, but it gives tool authors the key they need to make side effects idempotent.

To avoid breaking every existing `RunStore` immediately, introduce this as a new optional interface first, for example a `claimPendingAction` capability. Bundled stores can implement it first; custom stores can fall back to a documented weaker path or fail fast when approval APIs are used without claim support.

### 6. Approve, Reject, and Cancel APIs

Add runtime APIs to resolve policy-driven pending actions:

- `approvePendingAction`
- `rejectPendingAction`
- `cancelPendingAction`

Approval must:

- Load the run from `RunStore`.
- Verify the run is still `waiting`.
- Verify the pending action ID matches.
- Verify project, tenant, session, and agent binding.
- Re-run authorization against current policy and host context.
- Execute the exact prepared action, not re-parsed model input.

Reject and cancel must not execute the tool. They should append a structured observation or terminal state according to documented semantics.

This should be implemented in core runtime APIs first. REST endpoints can be added afterward as a separate adapter concern.

`AgentRuntime` currently owns configuration and dispatch, not a specific session. Approval APIs should therefore accept an explicit `Session` or identity input, similar to run/resume flows, rather than relying on ambient runtime state.

Expose class methods on `AgentRuntime` only if that remains ergonomic, but keep the internal implementation as standalone helpers. REST, workers, browser code, tests, and custom hosts should be able to call a shared function without inflating the runtime class.

Approval should default to executing the tool, appending the observation, and continuing the engine loop. Add an explicit mode for hosts that only want the side effect:

```ts
mode?: "execute_and_continue" | "execute_only";
```

Default mode should be `execute_and_continue`, because that matches the natural agent flow after a tool observation.

### 7. SecurityContext Enforcement Helpers

Keep `SecurityContext` simple, but make it useful for generic authorization.

Implement helper utilities for common checks:

- required scopes
- required roles
- deny-by-default scoped tool policy
- diagnostics for why a tool was hidden or denied

Do not make all tools declare scopes immediately. Start with helpers and optional policy integration so current tools remain compatible.

Visibility authorization and execution authorization should be documented separately:

- Visibility decides whether the model can see a tool.
- Execution authorization decides whether a prepared tool call may run.

Recommended source model:

- `Session` carries stable identity fields.
- `AgentRuntime` can accept a `securityContextResolver`.
- If no resolver is configured, keep the current `securityContextForAgent` behavior.

### 8. Minimal Tool Events

Define a stable public event model independent of internal `EngineHooks`.

Do not wait too long to add the tool-action event seam. The first policy PRs should emit or internally record minimal events from the action pipeline:

- `tool_proposed`
- `tool_denied`
- `tool_awaiting_approval`
- `tool_started`
- `tool_completed`
- `tool_failed`

These can be a minimal first version of the public model or an internal event builder that will become public. The key is to avoid reopening the action pipeline later just to add event points.

### 9. Public Run Events

The existing hooks are useful, but they are not a durable public contract. Add a `PublicRunEvent` schema with versioned, JSON-serializable events for:

- run lifecycle
- LLM start and completion summaries
- tool proposed
- tool awaiting approval
- tool started
- tool completed
- tool failed
- run waiting
- run resumed
- run completed
- run failed
- run cancelled
- usage updated

The model should work for browser UI, REST/SSE, workers, logs, and tests.

Redis run events can later be migrated to this model instead of publishing hook-specific payloads.

The event sink should be configured in core, while Redis/SSE should become one consumer. This keeps browser UIs, server logs, and REST streaming on the same schema without coupling core to Redis.

### 10. Redaction Hooks

Add a host-provided redactor for public events and other externally visible records.

Initial scope:

- tool input in public events
- tool output in public events
- LLM raw response summaries
- history values exposed through public APIs

Do not try to solve all audit-log storage semantics in the first pass. Start by ensuring public event streams and browser-visible surfaces can be redacted consistently.

### 11. Host Context Lifecycle

Split identity context from mutable host context.

Identity context should remain stable for a run or approval boundary:

- principal
- project
- tenant
- end user
- roles
- scopes

Host context can change between turns or approval:

- route
- page/resource hints
- feature flags
- environment
- UI state

Approving a pending action should allow refreshed host context and reauthorization. Diagnostics should record the host context version used for the decision.

This is important for browser and product UI integrations, but it can come after the core approval path exists.

### 12. Browser Lifecycle Hardening

Add one deterministic browser execution test that imports `@opencoreagents/core`, runs a deterministic LLM adapter, executes one tool, and produces a final result without Node polyfills.

Document browser restore behavior for:

- `running` after reload
- `waiting` after reload
- `completed` after reload
- `failed` after reload
- cancelled or abandoned runs
- tab suspension
- quota failure
- IndexedDB unavailable

This builds on the browser package rather than moving browser-specific logic into core.

### 13. Reusable Contract Tests

Introduce reusable adapter contract suites over time.

Start with:

- `RunStore`
- pending approval claim behavior
- public event serialization and redaction
- browser IndexedDB structured-clone behavior

Do not block the policy work on a full contract-test framework. Add contracts as each new boundary stabilizes.

## What We Should Not Implement Literally

The external requirements are useful, but they should not be copied one-for-one into OpenCore Agents.

Avoid:

- Replacing the existing agent, skill, and runtime allowlist model.
- Making every existing tool define roles or scopes before the policy system exists.
- Treating public events as the same thing as internal engine hooks.
- Adding REST approval endpoints before core runtime APIs exist.
- Making browser lifecycle logic part of `@opencoreagents/core`.
- Claiming exactly-once side effects. OpenCore can provide idempotency keys and at-most-one execution at its boundary; external systems must still honor idempotency.
- Storing raw tool inputs or outputs in public events by default.

## Suggested Implementation Order

1. Add `prepareInput` to `ToolAdapter` and `ToolRunner`.
2. Add pre-tool execution policy with `allow` and `deny`.
3. Add tool visibility policy in context building, using inputs compatible with execution policy.
4. Add minimal tool-action event points.
5. Add `wait` policy decision and discriminated pending tool-action state.
6. Add action-level claim semantics and idempotency key in `ToolContext`.
7. Add approve, reject, and cancel runtime helpers/APIs on top of the claim path.
8. Add public run event model and event sink.
9. Add redaction hooks for public events.
10. Add `SecurityContext` helper policies, resolver, and docs.
11. Add host context snapshot and refreshed approval context.
12. Add browser execution E2E and restore-semantics docs.
13. Extract reusable contract suites as APIs stabilize.

## Compatibility Strategy

Existing tools should continue to work:

- Tools without `prepareInput` keep using `validate`.
- Runtimes without policy hooks behave as they do today.
- Existing model-driven `wait` remains valid.
- Existing `RunStore` implementations continue to compile if action-claim support is introduced behind a new optional interface or versioned extension.
- Existing `EngineHooks` remain available even after public events are added.

Where a breaking change becomes necessary, prefer a minor transitional interface first, then tighten contracts in a later major release.

## Open Questions

- Should denied policy decisions be visible to the LLM as observations, or should some denials terminate the run?
- Should public run events require a new `llm_started` hook around `llmAdapter.generate`, or is the first public version allowed to begin at `llm_completed`?
- Should visibility policy run once per engine turn or once per run with cached diagnostics?
- Which public event fields are safe defaults before a host redactor is configured?
- How much of the standalone approval helper surface should also be exposed as convenience methods on `AgentRuntime`?
- Should `execute_only` approval mode append an observation but stop immediately, or should it execute without modifying model-visible history?

## Recommendation

Implement the first production slice as:

1. `prepareInput`
2. execution policy with `allow` and `deny`
3. visibility policy using compatible inputs
4. minimal tool-action events
5. execution policy with `wait`
6. discriminated pending-action state
7. pending-action claim and idempotency key
8. approve, reject, and cancel runtime helpers/APIs

That slice delivers the core safety boundary without forcing public events, browser semantics, or contract-test infrastructure to be solved first. Once it is stable, public events and redaction become much easier because tool input, policy decisions, pending state, and execution outcomes all have canonical values.

The first implementation PR should stay smaller than that full slice:

```text
PR 1: canonical tool input preparation
- Add ToolAdapter.prepareInput.
- Add ToolRunner preparation API.
- Keep validate fallback.
- Add tests for transform, defaulting, coercion, failure, and legacy validate behavior.
- Do not add policy yet.
```

## Staged PR Plan

Use this section as the working checklist for implementation. Keep each PR narrow enough that reviewers can validate one boundary at a time.

### PR 1: Canonical Tool Input Preparation

Status: in progress / nearly ready.

Scope:

- Add `ToolAdapter.prepareInput`.
- Add `ToolInputPreparation`.
- Add a stable `PreparedToolAction` result shape.
- Split `ToolRunner` into preparation and prepared execution APIs.
- Keep `ToolRunner.execute(...)` as a backward-compatible convenience wrapper.
- Resolve the tool and enforce the effective allowlist before preparation.
- Ensure `tool.execute(...)` receives the prepared input.
- Do not add execution policy, visibility policy, approvals, public events, or redaction in this PR.

Required checks:

- Existing legacy tools with `validate` still work.
- Legacy validation failures do not execute the tool.
- `prepareInput` can transform, default, and coerce input.
- Failed preparation does not execute the tool.
- Unknown or disallowed tools are rejected before `prepareInput`.
- Async `prepareInput` is awaited.
- Tool execution timeouts still behave as before.
- `ToolRunner.execute(...)` remains backward compatible.

Remaining checks before merge:

- Add an explicit test proving `prepareInput` is called exactly once per proposed action.
- Add an engine-level integration test proving the LLM action path uses `prepareInput` and appends an observation from the prepared input.
- Add a test for `prepareInput` throwing or rejecting, proving the tool does not execute and the failure becomes a safe tool failure observation.
- Decide whether unrelated `.gitignore` additions belong in this PR. If they are not required for canonical tool input, move them to a separate cleanup PR or mention them explicitly in the PR description.

Suggested PR description:

```text
Adds canonical tool input preparation.

This introduces ToolAdapter.prepareInput and separates ToolRunner preparation from prepared execution, so future policy, approval, hashing, and event work can use one canonical input value.

This PR does not add execution policy, visibility policy, approval state, public events, or redaction.
```

### PR 2: Execution Policy Allow/Deny

Scope:

- Add a runtime-level execution policy hook.
- Support only `allow` and `deny` decisions.
- Run the policy after input preparation and validation.
- Run the policy before `tool.execute`.
- Pass the prepared input to policy, not raw model input.
- Keep behavior unchanged when no policy is configured.
- Do not add `wait`, pending actions, approval APIs, or visibility policy in this PR unless needed for shared type design.

Policy input should include:

- `agent`
- `session`
- `run`
- `tool`
- `preparedInput`
- `securityContext`
- optional `hostContext`

Acceptance criteria:

- `allow` executes the tool.
- `deny` does not execute the tool.
- `deny` appends or returns a safe structured failure observation.
- Policy receives the same prepared value that would be passed to `tool.execute`.
- Existing static allowlist behavior remains backward compatible.
- Existing runs without a policy behave as they do today.

Tests:

- Policy `allow` executes.
- Policy `deny` does not execute.
- Denied action produces a safe observation.
- Policy sees prepared input after `prepareInput` transformation.
- Policy is not called for unknown or disallowed tools before preparation.
- No configured policy keeps current behavior.

### PR 3: Tool Visibility Policy

Scope:

- Add a host-provided visibility policy for the prompt tool catalog.
- Apply it after the existing effective allowlist is computed.
- Never allow the policy to add tools outside the candidate set.
- Keep execution-side allowlist checks in `ToolRunner`.

Acceptance criteria:

- Hidden tools are not sent to the LLM.
- A malformed/model-proposed hidden tool is still rejected before execution.
- Existing static allowlist behavior remains backward compatible.
- Visibility and execution policy inputs stay compatible enough that hosts can share authorization logic.

### PR 4: Minimal Tool-Action Events

Scope:

- Add event points around the tool-action pipeline.
- Start with minimal tool-action events before attempting the full public run event model.

Initial events:

- `tool_proposed`
- `tool_denied`
- `tool_started`
- `tool_completed`
- `tool_failed`

If PR 5 is ready soon after, add `tool_awaiting_approval` there with the policy-driven wait path.

Acceptance criteria:

- Events are JSON-serializable.
- Events use prepared input where input is included.
- Events do not expose raw tool input/output by default unless explicitly configured.
- Existing `EngineHooks` remain available.

### PR 5: Policy Wait and Pending Tool Action

Scope:

- Add execution policy decision `wait`.
- Add discriminated `run.state.pending` shapes for `model_wait` and `tool_approval`.
- Persist enough state to resume the exact prepared action.
- Require `RunStore` by default for policy-driven approvals.
- Allow ephemeral in-process approval only through an explicit opt-in.
- Do not implement full approve/reject/cancel API surface until claim semantics are designed.

Acceptance criteria:

- `wait` does not execute the tool.
- `wait` transitions the run to `waiting`.
- Pending action includes `actionId`, `toolName`, prepared input or protected reference, `inputHash`, reason, timestamps, and optional policy version.
- Missing approval-capable persistence fails fast with a clear error unless ephemeral mode is explicitly enabled.

### PR 6: Pending Action Claim and Approval APIs

Scope:

- Add action-level claim semantics.
- Generate and pass a stable idempotency key through `ToolContext`.
- Add standalone helpers for approve, reject, and cancel.
- Add `AgentRuntime` convenience methods only if the helper surface stays ergonomic.

Acceptance criteria:

- Concurrent approval executes at most once at the OpenCore boundary.
- Duplicate approval gets a stale or already-claimed error.
- Approved execution uses the exact prepared action.
- Approval re-runs authorization against current policy and host context.
- Wrong session, project, tenant, or agent cannot approve.

Default approval mode:

```ts
mode?: "execute_and_continue" | "execute_only";
```

Default should be `execute_and_continue`.
