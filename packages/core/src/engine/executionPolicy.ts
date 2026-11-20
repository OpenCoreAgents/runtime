import type { ToolAdapter } from "../adapters/tool/ToolAdapter.js";
import type { AgentDefinition } from "../define/types.js";
import type { Session } from "../define/Session.js";
import type { Run } from "../protocol/types.js";
import type { SecurityContext } from "../security/types.js";

/**
 * Decision returned by an {@link ExecutionPolicy}.
 *
 * PR 2 supports only `allow` and `deny`. Future PRs will add `wait` for
 * pending human/tool approval.
 */
export type ExecutionPolicyDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason?: string; details?: unknown };

/**
 * Inputs provided to every execution policy evaluation.
 *
 * The policy receives the same canonical prepared input that will be passed
 * to `tool.execute`, never the raw model output.
 */
export interface ExecutionPolicyInput {
  agent: AgentDefinition;
  session: Session;
  run: Run;
  tool: ToolAdapter;
  preparedInput: unknown;
  securityContext: SecurityContext;
  /** Arbitrary host-resolved context (JWT claims, BFF headers, etc.). */
  hostContext?: unknown;
}

/**
 * Optional runtime-level hook executed after tool input preparation and
 * validation, but before `tool.execute`.
 *
 * Returning `deny` aborts execution and appends a safe failure observation.
 */
export type ExecutionPolicy = (
  input: ExecutionPolicyInput,
) => ExecutionPolicyDecision | Promise<ExecutionPolicyDecision>;
