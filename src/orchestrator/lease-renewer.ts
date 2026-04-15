import type { PlanningBackend } from "../core/planning-backend.js";
import type { WorkItemRecord } from "../domain-model.js";

import type {
  LeaseObservation,
  LeaseRenewalDecision,
} from "./reconciliation-types.js";
import { evaluateLeaseRenewal } from "./run-liveness.js";
import type { ObservedRuntimeRun } from "./runtime-observer.js";

export type RenewLeaseIfNeededInput = {
  planning: PlanningBackend;
  workItem: WorkItemRecord;
  runtimeRun: ObservedRuntimeRun | null;
  runtimeHealthy: boolean;
  owner: string;
  leaseDurationMs: number;
  observation?: LeaseObservation | null;
  now?: Date;
};

export type RenewLeaseIfNeededResult = {
  decision: LeaseRenewalDecision;
  workItem: WorkItemRecord;
  renewed: boolean;
  promotedToRunning: boolean;
};

export async function renewLeaseIfNeeded(
  input: RenewLeaseIfNeededInput,
): Promise<RenewLeaseIfNeededResult> {
  const decision = evaluateLeaseRenewal({
    workItem: input.workItem,
    runtimeRun: input.runtimeRun,
    runtimeHealthy: input.runtimeHealthy,
    observation: input.observation,
    now: input.now,
    leaseDurationMs: input.leaseDurationMs,
  });

  let nextWorkItem = input.workItem;
  let renewed = false;
  let promotedToRunning = false;
  const currentRunId =
    nextWorkItem.orchestration.runId ?? input.workItem.orchestration.runId ?? null;
  const leaseUntil =
    decision.nextLeaseUntil ??
    nextWorkItem.orchestration.leaseUntil ??
    null;

  if (
    decision.promoteToRunning &&
    leaseUntil !== null &&
    currentRunId !== null
  ) {
    nextWorkItem = await input.planning.markWorkItemRunning({
      id: nextWorkItem.id,
      owner: input.owner,
      runId: currentRunId,
      leaseUntil,
    });
    promotedToRunning = true;
  }

  if (decision.renew && decision.nextLeaseUntil !== null && currentRunId !== null) {
    nextWorkItem = await input.planning.renewLease({
      id: nextWorkItem.id,
      owner: input.owner,
      runId: currentRunId,
      leaseUntil: decision.nextLeaseUntil,
    });
    renewed = true;
  }

  return {
    decision,
    workItem: nextWorkItem,
    renewed,
    promotedToRunning,
  };
}
