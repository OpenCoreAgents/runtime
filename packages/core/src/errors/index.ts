export abstract class EngineError extends Error {
  abstract readonly code: string;
  constructor(message?: string) {
    super(message ?? "Unspecified engine error");
    this.name = new.target.name;
  }
}

export class RunInvalidStateError extends EngineError {
  readonly code = "RUN_INVALID_STATE";
}
export class StepSchemaError extends EngineError {
  readonly code = "STEP_SCHEMA_ERROR";
}
export class ToolNotAllowedError extends EngineError {
  readonly code = "TOOL_NOT_ALLOWED";
}
export class ToolExecutionError extends EngineError {
  readonly code = "TOOL_EXECUTION_ERROR";
}
export class ToolValidationError extends EngineError {
  readonly code = "TOOL_VALIDATION_ERROR";
  readonly details?: string;
  constructor(message?: string, details?: string) {
    super(message);
    this.details = details;
  }
}
export class ToolPreparationError extends EngineError {
  readonly code = "TOOL_PREPARATION_ERROR";
  readonly details?: string;
  constructor(message?: string, details?: string) {
    super(message);
    this.details = details;
  }
}
export class ExecutionPolicyError extends EngineError {
  readonly code = "EXECUTION_POLICY_DENIED";
  readonly details?: unknown;
  constructor(message?: string, details?: unknown) {
    super(message ?? "Execution denied by policy");
    this.details = details;
  }
}
export class ExecutionWaitError extends EngineError {
  readonly code = "EXECUTION_WAIT";
  readonly reason?: string;
  readonly details?: unknown;
  readonly ttlMs?: number;
  constructor(message?: string, reason?: string, details?: unknown, ttlMs?: number) {
    super(message ?? "Execution paused for approval");
    this.reason = reason;
    this.details = details;
    this.ttlMs = ttlMs;
  }
}
export class ExecutionNotAllowedError extends EngineError {
  readonly code = "EXECUTION_NOT_ALLOWED";
}
export class ToolTimeoutError extends EngineError {
  readonly code = "TOOL_TIMEOUT";
}
export class MaxIterationsError extends EngineError {
  readonly code = "MAX_ITERATIONS_EXCEEDED";
  constructor(message?: string) {
    super(message ?? "Exceeded maximum engine iterations");
  }
}
export class RunTimeoutError extends EngineError {
  readonly code = "RUN_TIMEOUT";
  constructor(message?: string) {
    super(message ?? "Run exceeded the configured time limit");
  }
}
export class LLMTransportError extends EngineError {
  readonly code = "LLM_TRANSPORT_ERROR";
}
export class LLMRateLimitError extends EngineError {
  readonly code = "LLM_RATE_LIMIT";
}
export class LLMClientError extends EngineError {
  readonly code = "LLM_CLIENT_ERROR";
}
export class RunCancelledError extends EngineError {
  readonly code = "RUN_CANCELLED";
  constructor(message?: string) {
    super(message ?? "Run was cancelled");
  }
}
export class SecurityError extends EngineError {
  readonly code = "SECURITY_DENIED";
}
export class SessionExpiredError extends EngineError {
  readonly code = "SESSION_EXPIRED";
}

/** Queued job included **`expiresAtMs`** and the worker ran after that deadline (see `adapters-bullmq` payload). */
export class EngineJobExpiredError extends EngineError {
  readonly code = "ENGINE_JOB_EXPIRED";
}
