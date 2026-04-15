import type { WorkItemRecord } from "../domain-model.js";

import type {
  ExecutableWorkPhase,
  PhaseResolution,
} from "./types.js";

const ACTIONABLE_STATUS_PHASES = {
  design: "design",
  plan: "plan",
  implement: "implement",
  review: "review",
} as const satisfies Record<string, ExecutableWorkPhase>;

export function resolvePhase(workItem: WorkItemRecord): PhaseResolution {
  const expectedPhase = getExpectedPhase(workItem.status);

  if (expectedPhase === null) {
    if (workItem.status === "blocked") {
      return {
        actionable: false,
        reason: "blocked_status",
        message: `Work item '${workItem.id}' is blocked and cannot be claimed automatically.`,
        phase: workItem.phase,
      };
    }

    return {
      actionable: false,
      reason: "status_not_actionable",
      message: `Work item '${workItem.id}' is in non-actionable status '${workItem.status}'.`,
      phase: workItem.phase,
    };
  }

  if (workItem.phase === "none") {
    return {
      actionable: false,
      reason: "phase_missing",
      message: `Work item '${workItem.id}' is actionable by status '${workItem.status}' but has no canonical phase.`,
      phase: workItem.phase,
      expectedPhase: expectedPhase,
    };
  }

  if (workItem.phase === "merge") {
    return {
      actionable: false,
      reason: "reserved_phase",
      message: `Work item '${workItem.id}' is in reserved phase 'merge'.`,
      phase: workItem.phase,
      expectedPhase: expectedPhase,
    };
  }

  if (workItem.phase !== expectedPhase) {
    return {
      actionable: false,
      reason: "phase_mismatch",
      message: `Work item '${workItem.id}' is in status '${workItem.status}' but canonical phase '${workItem.phase}'.`,
      phase: workItem.phase,
      expectedPhase: expectedPhase,
    };
  }

  return {
    actionable: true,
    phase: expectedPhase,
  };
}

function getExpectedPhase(
  status: WorkItemRecord["status"],
): ExecutableWorkPhase | null {
  return status in ACTIONABLE_STATUS_PHASES
    ? ACTIONABLE_STATUS_PHASES[status as keyof typeof ACTIONABLE_STATUS_PHASES]
    : null;
}
