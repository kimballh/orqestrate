export const RUNTIME_ERROR_CODES = [
  "database_close_failed",
  "database_open_failed",
  "duplicate_runtime_adapter",
  "invalid_request",
  "invalid_run_state_transition",
  "live_session_not_found",
  "migration_failed",
  "run_prompt_missing",
  "run_not_found",
  "runtime_adapter_not_found",
  "runtime_not_started",
  "workspace_allocation_not_found",
] as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

type RuntimeErrorOptions = {
  code: RuntimeErrorCode;
  cause?: unknown;
};

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(message: string, options: RuntimeErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "RuntimeError";
    this.code = options.code;
  }
}
