import type { RunStatus, WorkItemRecord } from "../domain-model.js";

import { computeLeaseUntil } from "./identity.js";
import type {
  LeaseObservation,
  LeaseRenewalDecision,
} from "./reconciliation-types.js";
import type { ObservedRuntimeRun } from "./runtime-observer.js";

const ACTIVE_RUNTIME_STATUSES = new Set<RunStatus>([
  "admitted",
  "launching",
  "bootstrapping",
  "running",
  "stopping",
]);

const TERMINAL_RUNTIME_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "canceled",
  "stale",
]);

const RUNNING_RUNTIME_STATUSES = new Set<RunStatus>([
  "bootstrapping",
  "running",
  "stopping",
]);

export type EvaluateLeaseRenewalInput = {
  workItem: WorkItemRecord;
  runtimeRun: ObservedRuntimeRun | null;
  runtimeHealthy: boolean;
  observation?: LeaseObservation | null;
  now?: Date;
  leaseDurationMs: number;
  renewalThresholdMs?: number;
};

export function isLeaseManagedState(workItem: WorkItemRecord): boolean {
  return (
    workItem.orchestration.state === "claimed" ||
    workItem.orchestration.state === "running"
  );
}

export function isRuntimeTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_RUNTIME_STATUSES.has(status);
}

export function isRuntimeActiveStatus(status: RunStatus): boolean {
  return ACTIVE_RUNTIME_STATUSES.has(status);
}

export function shouldPromotePlanningToRunning(status: RunStatus): boolean {
  return RUNNING_RUNTIME_STATUSES.has(status);
}

export function captureLeaseObservation(
  run: ObservedRuntimeRun,
  input: {
    workItem: WorkItemRecord;
    observedAt?: string;
  },
): LeaseObservation {
  return {
    runId: run.runId,
    workItemId: input.workItem.id,
    status: run.status,
    leaseUntil: input.workItem.orchestration.leaseUntil ?? null,
    lastHeartbeatAt: run.lastHeartbeatAt ?? null,
    lastEventSeq: run.lastEventSeq,
    observedAt: input.observedAt ?? new Date().toISOString(),
  };
}

export function evaluateLeaseRenewal(
  input: EvaluateLeaseRenewalInput,
): LeaseRenewalDecision {
  const now = input.now ?? new Date();
  const thresholdMs =
    input.renewalThresholdMs ?? Math.floor(input.leaseDurationMs / 3);
  const promoteToRunning =
    input.runtimeRun !== null &&
    input.workItem.orchestration.state === "claimed" &&
    shouldPromotePlanningToRunning(input.runtimeRun.status);

  if (!isLeaseManagedState(input.workItem)) {
    return {
      renew: false,
      promoteToRunning,
      reason: "planning_not_leased",
      nextLeaseUntil: null,
      observation: input.runtimeRun === null
        ? null
        : captureLeaseObservation(input.runtimeRun, { workItem: input.workItem }),
    };
  }

  if (input.runtimeRun === null) {
    return {
      renew: false,
      promoteToRunning: false,
      reason: "run_missing",
      nextLeaseUntil: null,
      observation: null,
    };
  }

  if (input.workItem.orchestration.runId !== input.runtimeRun.runId) {
    return {
      renew: false,
      promoteToRunning: false,
      reason: "run_id_mismatch",
      nextLeaseUntil: null,
      observation: captureLeaseObservation(input.runtimeRun, {
        workItem: input.workItem,
      }),
    };
  }

  if (!input.runtimeHealthy) {
    return {
      renew: false,
      promoteToRunning,
      reason: "runtime_unhealthy",
      nextLeaseUntil: null,
      observation: captureLeaseObservation(input.runtimeRun, {
        workItem: input.workItem,
      }),
    };
  }

  if (!isRuntimeActiveStatus(input.runtimeRun.status)) {
    return {
      renew: false,
      promoteToRunning: false,
      reason: "runtime_not_active",
      nextLeaseUntil: null,
      observation: captureLeaseObservation(input.runtimeRun, {
        workItem: input.workItem,
      }),
    };
  }

  const remainingLeaseMs = computeRemainingLeaseMs(
    input.workItem.orchestration.leaseUntil,
    now,
  );
  if (remainingLeaseMs === null || remainingLeaseMs > thresholdMs) {
    return {
      renew: false,
      promoteToRunning,
      reason: "lease_not_due",
      nextLeaseUntil: null,
      observation: captureLeaseObservation(input.runtimeRun, {
        workItem: input.workItem,
      }),
    };
  }

  const hasFreshEvidence = hasFreshLivenessEvidence(
    input.runtimeRun,
    input.observation ?? null,
  );
  if (!hasFreshEvidence) {
    if (canUseBootstrapGrace(input.runtimeRun, now)) {
      return {
        renew: true,
        promoteToRunning,
        reason: "bootstrap_grace",
        nextLeaseUntil: computeLeaseUntil(now, input.leaseDurationMs),
        observation: captureLeaseObservation(input.runtimeRun, {
          workItem: input.workItem,
          observedAt: now.toISOString(),
        }),
      };
    }

    return {
      renew: false,
      promoteToRunning,
      reason: "no_fresh_evidence",
      nextLeaseUntil: null,
      observation: captureLeaseObservation(input.runtimeRun, {
        workItem: input.workItem,
      }),
    };
  }

  return {
    renew: true,
    promoteToRunning,
    reason: "fresh_evidence",
    nextLeaseUntil: computeLeaseUntil(now, input.leaseDurationMs),
    observation: captureLeaseObservation(input.runtimeRun, {
      workItem: input.workItem,
      observedAt: now.toISOString(),
    }),
  };
}

function computeRemainingLeaseMs(
  leaseUntil: string | null | undefined,
  now: Date,
): number | null {
  if (leaseUntil === undefined || leaseUntil === null || leaseUntil.trim() === "") {
    return null;
  }

  const leaseAt = Date.parse(leaseUntil);
  if (!Number.isFinite(leaseAt)) {
    return null;
  }

  return leaseAt - now.getTime();
}

function hasFreshLivenessEvidence(
  run: ObservedRuntimeRun,
  observation: LeaseObservation | null,
): boolean {
  if (observation === null) {
    return (
      run.lastHeartbeatAt !== null ||
      run.lastEventSeq !== null ||
      run.status === "running" ||
      run.status === "stopping"
    );
  }

  const latestHeartbeat = parseTimestamp(run.lastHeartbeatAt);
  const observedHeartbeat = parseTimestamp(observation.lastHeartbeatAt);
  if (latestHeartbeat !== null && (observedHeartbeat === null || latestHeartbeat > observedHeartbeat)) {
    return true;
  }

  if (
    run.lastEventSeq !== null &&
    (observation.lastEventSeq === null || run.lastEventSeq > observation.lastEventSeq)
  ) {
    return true;
  }

  return run.status !== observation.status;
}

function canUseBootstrapGrace(
  run: ObservedRuntimeRun,
  now: Date,
): boolean {
  if (run.status !== "launching" && run.status !== "bootstrapping") {
    return false;
  }

  const startedAt = parseTimestamp(run.startedAt ?? run.admittedAt ?? null);
  if (startedAt === null) {
    return false;
  }

  return now.getTime() - startedAt <= run.limits.bootstrapTimeoutSec * 1000;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (value === undefined || value === null || value.trim() === "") {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
