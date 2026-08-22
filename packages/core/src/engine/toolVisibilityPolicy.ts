import type { ToolAdapter } from "../adapters/tool/ToolAdapter.js";
import type { AgentDefinition } from "../define/types.js";
import type { Session } from "../define/Session.js";
import type { Run } from "../protocol/types.js";
import type { SecurityContext } from "../security/types.js";

/**
 * Inputs provided to every tool visibility policy evaluation.
 *
 * Kept compatible with {@link ExecutionPolicyInput} so hosts can reuse
 * authorization logic across visibility and execution decisions.
 */
export interface ToolVisibilityPolicyInput {
  agent: AgentDefinition;
  session: Session;
  run: Run;
  tool: ToolAdapter;
  securityContext: SecurityContext;
  /** Arbitrary host-resolved context (JWT claims, BFF headers, etc.). */
  hostContext?: unknown;
}

/**
 * Decision returned by a {@link ToolVisibilityPolicy}.
 */
export interface ToolVisibilityPolicyResult {
  visible: boolean;
  reason?: string;
}

/**
 * Optional host-provided filter for the prompt tool catalog.
 *
 * Runs after the effective tool allowlist is computed and can only hide tools
 * from the LLM — it may never add tools outside the candidate set.
 */
export type ToolVisibilityPolicy = (
  input: ToolVisibilityPolicyInput,
) => ToolVisibilityPolicyResult | Promise<ToolVisibilityPolicyResult>;
