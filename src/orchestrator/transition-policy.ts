import type { TransitionWorkItemInput } from "../core/planning-backend.js";
import type {
  ProviderError,
  ProviderErrorCode,
  ProviderFamily,
  WorkItemRecord,
} from "../domain-model.js";

import type {
  PostClaimFailureContext,
  PreflightFailureDisposition,
} from "./types.js";

export class HumanBlockerError extends Error {
  readonly blockedReason: string;
  readonly providerError?: ProviderError | null;

  constructor(blockedReason: string, options?: { providerError?: ProviderError | null }) {
    super(blockedReason);
    this.name = "HumanBlockerError";
    this.blockedReason = blockedReason;
    this.providerError = options?.providerError ?? null;
  }
}

export function buildRetryableFailureTransition(input: {
  workItem: WorkItemRecord;
  runId: string;
  error: ProviderError;
}): TransitionWorkItemInput {
  return {
    id: input.workItem.id,
    nextStatus: input.workItem.status,
    nextPhase: input.workItem.phase,
    state: "failed",
    lastError: input.error,
    blockedReason: null,
    runId: input.runId,
  };
}

export function buildBlockedTransition(input: {
  workItem: WorkItemRecord;
  runId: string;
  blockedReason: string;
  error?: ProviderError | null;
}): TransitionWorkItemInput {
  return {
    id: input.workItem.id,
    nextStatus: "blocked",
    nextPhase: input.workItem.phase,
    state: "waiting_human",
    blockedReason: input.blockedReason,
    lastError: input.error ?? null,
    runId: input.runId,
  };
}

export function defaultClassifyPostClaimFailure(
  error: unknown,
  context: PostClaimFailureContext,
): PreflightFailureDisposition {
  if (error instanceof HumanBlockerError) {
    return {
      kind: "blocked",
      blockedReason: error.blockedReason,
      error: error.providerError ?? null,
    };
  }

  return {
    kind: "retryable",
    error: toProviderError(
      error,
      inferProviderFailureFamily(context.step),
      inferProviderFailureKind(context.step),
    ),
  };
}

export function toProviderError(
  error: unknown,
  providerFamily: ProviderFamily,
  providerKind: string,
  defaultCode: ProviderErrorCode = "unknown",
): ProviderError {
  if (isProviderError(error)) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    providerFamily,
    providerKind,
    code: defaultCode,
    message,
    retryable: true,
    details:
      error instanceof Error && error.name !== "Error"
        ? { errorName: error.name }
        : null,
  };
}

function inferProviderFailureFamily(
  step: PostClaimFailureContext["step"],
): ProviderFamily {
  if (
    step === "ensure_artifact" ||
    step === "load_context" ||
    step === "create_run_ledger"
  ) {
    return "context";
  }

  return "runtime";
}

function inferProviderFailureKind(step: PostClaimFailureContext["step"]): string {
  switch (step) {
    case "ensure_artifact":
    case "load_context":
    case "create_run_ledger":
      return "context_backend";
    case "assemble_prompt":
      return "prompt_assembly";
    case "build_submission":
      return "orchestrator";
    default:
      return "orchestrator";
  }
}

function isProviderError(value: unknown): value is ProviderError {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ProviderError>;
  return (
    typeof candidate.providerFamily === "string" &&
    typeof candidate.providerKind === "string" &&
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.retryable === "boolean"
  );
}
