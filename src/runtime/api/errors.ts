import { RuntimeError } from "../errors.js";
import type { ErrorResponse } from "./types.js";

export function toHttpErrorResponse(error: unknown): {
  status: number;
  body: ErrorResponse;
} {
  if (error instanceof RuntimeError) {
    return {
      status: statusForRuntimeError(error.code),
      body: {
        error: {
          code: error.code,
          message: error.message,
          retryable: isRetryableRuntimeError(error.code),
        },
      },
    };
  }

  if (error instanceof SyntaxError) {
    return {
      status: 400,
      body: {
        error: {
          code: "invalid_request",
          message: "Request body was not valid JSON.",
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: "internal_error",
        message:
          error instanceof Error
            ? error.message
            : "Runtime API request failed unexpectedly.",
      },
    },
  };
}

function statusForRuntimeError(code: RuntimeError["code"]): number {
  switch (code) {
    case "invalid_request":
      return 400;
    case "run_not_found":
      return 404;
    case "invalid_run_state_transition":
    case "live_session_not_found":
      return 409;
    case "runtime_not_started":
    case "runtime_adapter_not_found":
    case "database_open_failed":
      return 503;
    default:
      return 500;
  }
}

function isRetryableRuntimeError(code: RuntimeError["code"]): boolean {
  switch (code) {
    case "runtime_not_started":
    case "runtime_adapter_not_found":
    case "database_open_failed":
      return true;
    default:
      return false;
  }
}
