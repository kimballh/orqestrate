import type { WorkItemRecord } from "../domain-model.js";

import type {
  ClaimDecision,
  PhaseResolution,
} from "./types.js";

export function evaluateClaimability(
  workItem: WorkItemRecord,
  resolution: PhaseResolution,
  now: Date = new Date(),
): ClaimDecision {
  if (!resolution.actionable) {
    return {
      claimable: false,
      reason: "phase_not_actionable",
      message: resolution.message,
    };
  }

  if (hasActiveLease(workItem.orchestration.leaseUntil, now)) {
    return {
      claimable: false,
      phase: resolution.phase,
      reason: "lease_active",
      message: `Work item '${workItem.id}' already has an active lease.`,
    };
  }

  if (workItem.blockedByIds.length > 0) {
    return {
      claimable: false,
      phase: resolution.phase,
      reason: "has_open_blockers",
      message: `Work item '${workItem.id}' still has open blockers.`,
    };
  }

  if (workItem.orchestration.state === "waiting_human") {
    return {
      claimable: false,
      phase: resolution.phase,
      reason: "waiting_human",
      message: `Work item '${workItem.id}' is waiting for human input.`,
    };
  }

  return {
    claimable: true,
    phase: resolution.phase,
    hasExpiredLease: hasExpiredLease(workItem.orchestration.leaseUntil, now),
  };
}

export function hasActiveLease(
  leaseUntil: string | null | undefined,
  now: Date = new Date(),
): boolean {
  const leaseTimestamp = parseLeaseTimestamp(leaseUntil);
  return leaseTimestamp !== null && leaseTimestamp > now.getTime();
}

export function hasExpiredLease(
  leaseUntil: string | null | undefined,
  now: Date = new Date(),
): boolean {
  const leaseTimestamp = parseLeaseTimestamp(leaseUntil);
  return leaseTimestamp !== null && leaseTimestamp <= now.getTime();
}

function parseLeaseTimestamp(leaseUntil: string | null | undefined): number | null {
  if (leaseUntil === undefined || leaseUntil === null || leaseUntil.trim() === "") {
    return null;
  }

  const timestamp = Date.parse(leaseUntil);
  return Number.isFinite(timestamp) ? timestamp : null;
}
