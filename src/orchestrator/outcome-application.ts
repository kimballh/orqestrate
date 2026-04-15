import type { ContextBackend } from "../core/context-backend.js";
import type { PlanningBackend } from "../core/planning-backend.js";
import type {
  ProviderError,
  RunLedgerRecord,
  RunStatus,
  WorkItemRecord,
} from "../domain-model.js";

import { buildBlockedTransition, buildRetryableFailureTransition } from "./transition-policy.js";
import type { ObservedRuntimeRun } from "./runtime-observer.js";

export type RecoveredOutcomeInput = {
  planning: PlanningBackend;
  context: ContextBackend;
  workItem: WorkItemRecord;
  runtimeRun: ObservedRuntimeRun;
};

export type RecoveredOutcomeResult = {
  handled: boolean;
  workItem: WorkItemRecord;
  runLedger: RunLedgerRecord;
};

export async function applyRecoveredRuntimeOutcome(
  input: RecoveredOutcomeInput,
): Promise<RecoveredOutcomeResult> {
  const ledger = await ensureRunLedger(input);

  switch (input.runtimeRun.status) {
    case "waiting_human":
      return {
        handled: true,
        runLedger: await input.context.finalizeRunLedgerEntry({
          runId: ledger.runId,
          status: "waiting_human",
          summary:
            input.runtimeRun.waitingHumanReason ??
            input.runtimeRun.outcome?.summary ??
            "Run is waiting for human input.",
          error: input.runtimeRun.outcome?.error ?? null,
        }),
        workItem: await input.planning.transitionWorkItem(
          buildBlockedTransition({
            workItem: input.workItem,
            runId: input.runtimeRun.runId,
            blockedReason:
              input.runtimeRun.waitingHumanReason ??
              input.runtimeRun.outcome?.summary ??
              "Run is waiting for human input.",
            error: input.runtimeRun.outcome?.error ?? null,
          }),
        ),
      };
    case "failed":
    case "canceled":
    case "stale":
      return {
        handled: true,
        runLedger: await input.context.finalizeRunLedgerEntry({
          runId: ledger.runId,
          status: input.runtimeRun.status,
          summary: buildRecoveredOutcomeSummary(input.runtimeRun),
          error: buildRecoveredOutcomeError(input.runtimeRun),
        }),
        workItem: await input.planning.transitionWorkItem(
          buildRetryableFailureTransition({
            workItem: input.workItem,
            runId: input.runtimeRun.runId,
            error: buildRecoveredOutcomeError(input.runtimeRun),
          }),
        ),
      };
    default:
      return {
        handled: false,
        workItem: input.workItem,
        runLedger: ledger,
      };
  }
}

async function ensureRunLedger(
  input: RecoveredOutcomeInput,
): Promise<RunLedgerRecord> {
  const existing = await input.context.getRunLedgerEntry(input.runtimeRun.runId);

  if (existing !== null) {
    return existing;
  }

  return input.context.createRunLedgerEntry({
    runId: input.runtimeRun.runId,
    workItem: input.workItem,
    phase: input.runtimeRun.phase,
    status: normalizeRunLedgerStatus(input.runtimeRun.status),
  });
}

function normalizeRunLedgerStatus(status: RunStatus): RunStatus {
  return status === "admitted" || status === "launching" || status === "bootstrapping"
    ? "running"
    : status;
}

function buildRecoveredOutcomeSummary(run: ObservedRuntimeRun): string {
  return (
    run.outcome?.summary ??
    (run.status === "stale"
      ? "Run became stale before the orchestrator could complete write-back."
      : `Run ended with status '${run.status}'.`)
  );
}

function buildRecoveredOutcomeError(run: ObservedRuntimeRun): ProviderError {
  if (run.outcome?.error !== null && run.outcome?.error !== undefined) {
    return run.outcome.error;
  }

  return {
    providerFamily: "runtime",
    providerKind: run.provider,
    code: run.status === "stale" ? "unavailable" : "unknown",
    message: buildRecoveredOutcomeSummary(run),
    retryable: run.status !== "canceled",
    details: {
      reconciledStatus: run.status,
      recovered: true,
    },
  };
}
