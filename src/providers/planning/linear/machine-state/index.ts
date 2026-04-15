import type {
  OrchestrationState,
  ProviderError,
  ReviewOutcome,
  WorkPhaseOrNone,
} from "../../../../domain-model.js";

import type { LinearHydratedIssueRecord } from "../client.js";
import { createLinearFailure } from "../errors.js";

import {
  parseLinearDescriptionMachineState,
  type LinearDescriptionMachineState,
} from "./description-block.js";
import { readLinearMachineStateLabels } from "./label-binding.js";

export type LinearMachineState = LinearDescriptionMachineState & {
  phase: WorkPhaseOrNone | null;
  state: OrchestrationState | null;
  reviewOutcome: ReviewOutcome | null;
  description: string | null;
};

export function readLinearMachineState(
  issue: Pick<LinearHydratedIssueRecord, "id" | "identifier" | "description"> & {
    labels: string[];
  },
): LinearMachineState {
  try {
    const labelState = readLinearMachineStateLabels(issue.labels);
    const descriptionState = parseLinearDescriptionMachineState(issue.description);

    return {
      description: descriptionState.description,
      phase: labelState.phase,
      state: labelState.state,
      reviewOutcome: labelState.reviewOutcome,
      owner: descriptionState.machineState.owner,
      runId: descriptionState.machineState.runId,
      leaseUntil: descriptionState.machineState.leaseUntil,
      artifactUrl: descriptionState.machineState.artifactUrl,
      blockedReason: descriptionState.machineState.blockedReason,
      lastError: descriptionState.machineState.lastError,
      attemptCount: descriptionState.machineState.attemptCount,
    };
  } catch (error) {
    throw createMalformedMachineStateFailure(issue, error);
  }
}

function createMalformedMachineStateFailure(
  issue: Pick<LinearHydratedIssueRecord, "id" | "identifier">,
  error: unknown,
) {
  const reference = issue.identifier ?? issue.id;
  const detail = error instanceof Error ? error.message : String(error);

  return createLinearFailure(
    "validation",
    `Linear issue '${reference}' has malformed machine-owned state. ${detail}`,
    {
      details: {
        issueId: issue.id,
        issueIdentifier: issue.identifier ?? issue.id,
      },
    },
  );
}

export type {
  LinearDescriptionMachineState,
  ParsedLinearDescriptionMachineState,
} from "./description-block.js";
export {
  EMPTY_LINEAR_DESCRIPTION_MACHINE_STATE,
  parseLinearDescriptionMachineState,
  upsertLinearDescriptionMachineState,
} from "./description-block.js";
export type { LinearMachineStateLabels } from "./label-binding.js";
export { readLinearMachineStateLabels } from "./label-binding.js";
