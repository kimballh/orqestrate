import type {
  OrchestrationState,
  ProviderError,
  ReviewOutcome,
  WorkItemRecord,
  WorkItemStatus,
  WorkPhase,
  WorkPhaseOrNone,
} from "../../../domain-model.js";

import type {
  LinearHydratedIssueRecord,
  LinearIssueLabelRecord,
} from "./client.js";
import type { ResolvedLinearWorkflowStates } from "./config-adapter.js";
import {
  type LinearDescriptionMachineState,
  upsertLinearDescriptionMachineState,
} from "./machine-state/index.js";
import {
  buildLinearMachineStateLabelNames,
  isLinearProviderOwnedLabel,
  normalizeLinearLabelName,
} from "./machine-state/label-binding.js";

export type LinearIssueUpdatePatch = {
  stateId?: string;
  labelIds: string[];
  description: string;
};

export type LinearProviderLabelCatalog = ReadonlyMap<
  string,
  LinearIssueLabelRecord
>;

export function buildClaimPatch(input: {
  issue: LinearHydratedIssueRecord;
  record: WorkItemRecord;
  phase: WorkPhase;
  owner: string;
  runId: string;
  leaseUntil: string;
  labelCatalog: LinearProviderLabelCatalog;
}): LinearIssueUpdatePatch {
  return buildPatch({
    issue: input.issue,
    labelCatalog: input.labelCatalog,
    phase: input.phase,
    state: "claimed",
    reviewOutcome: input.record.orchestration.reviewOutcome ?? "none",
    descriptionState: {
      owner: input.owner,
      runId: input.runId,
      leaseUntil: input.leaseUntil,
      artifactUrl: input.record.artifactUrl ?? null,
      blockedReason: null,
      lastError: null,
      attemptCount: input.record.orchestration.attemptCount + 1,
    },
  });
}

export function buildRunningPatch(input: {
  issue: LinearHydratedIssueRecord;
  record: WorkItemRecord;
  owner: string;
  runId: string;
  leaseUntil: string;
  labelCatalog: LinearProviderLabelCatalog;
}): LinearIssueUpdatePatch {
  return buildPatch({
    issue: input.issue,
    labelCatalog: input.labelCatalog,
    phase: input.record.phase,
    state: "running",
    reviewOutcome: input.record.orchestration.reviewOutcome ?? "none",
    descriptionState: {
      owner: input.owner,
      runId: input.runId,
      leaseUntil: input.leaseUntil,
      artifactUrl: input.record.artifactUrl ?? null,
      blockedReason: input.record.orchestration.blockedReason ?? null,
      lastError: input.record.orchestration.lastError ?? null,
      attemptCount: input.record.orchestration.attemptCount,
    },
  });
}

export function buildLeaseRenewalPatch(input: {
  issue: LinearHydratedIssueRecord;
  record: WorkItemRecord;
  owner: string;
  runId: string;
  leaseUntil: string;
  labelCatalog: LinearProviderLabelCatalog;
}): LinearIssueUpdatePatch {
  return buildPatch({
    issue: input.issue,
    labelCatalog: input.labelCatalog,
    phase: input.record.phase,
    state: input.record.orchestration.state,
    reviewOutcome: input.record.orchestration.reviewOutcome ?? "none",
    descriptionState: {
      owner: input.owner,
      runId: input.runId,
      leaseUntil: input.leaseUntil,
      artifactUrl: input.record.artifactUrl ?? null,
      blockedReason: input.record.orchestration.blockedReason ?? null,
      lastError: input.record.orchestration.lastError ?? null,
      attemptCount: input.record.orchestration.attemptCount,
    },
  });
}

export function buildTransitionPatch(input: {
  issue: LinearHydratedIssueRecord;
  record: WorkItemRecord;
  nextStatus: WorkItemStatus;
  nextPhase: WorkPhaseOrNone;
  state: OrchestrationState;
  reviewOutcome?: ReviewOutcome | null;
  blockedReason?: string | null;
  lastError?: ProviderError | null;
  runId?: string | null;
  workflowStates: ResolvedLinearWorkflowStates;
  labelCatalog: LinearProviderLabelCatalog;
}): LinearIssueUpdatePatch {
  const resolvedPhase = deriveNextPhase(
    input.nextStatus,
    input.nextPhase,
    input.record.phase,
  );

  return buildPatch({
    issue: input.issue,
    stateId: input.workflowStates[input.nextStatus].id,
    labelCatalog: input.labelCatalog,
    phase: resolvedPhase,
    state: input.state,
    reviewOutcome: input.reviewOutcome ?? "none",
    descriptionState: {
      owner: null,
      runId:
        input.runId === undefined
          ? input.record.orchestration.runId ?? null
          : input.runId,
      leaseUntil: null,
      artifactUrl: input.record.artifactUrl ?? null,
      blockedReason:
        input.blockedReason === undefined
          ? input.nextStatus === "blocked"
            ? input.record.orchestration.blockedReason ?? null
            : null
          : input.blockedReason,
      lastError:
        input.lastError === undefined
          ? input.state === "failed"
            ? input.record.orchestration.lastError ?? null
            : null
          : input.lastError,
      attemptCount:
        resolvedPhase === input.record.phase
          ? input.record.orchestration.attemptCount
          : 0,
    },
  });
}

function buildPatch(input: {
  issue: LinearHydratedIssueRecord;
  stateId?: string;
  labelCatalog: LinearProviderLabelCatalog;
  phase: WorkPhaseOrNone;
  state: OrchestrationState;
  reviewOutcome: ReviewOutcome;
  descriptionState: LinearDescriptionMachineState;
}): LinearIssueUpdatePatch {
  const labelIds = [
    ...input.issue.labels
      .filter((label) => !isLinearProviderOwnedLabel(label.name))
      .map((label) => label.id),
    ...buildLinearMachineStateLabelNames({
      phase: input.phase,
      state: input.state,
      reviewOutcome: input.reviewOutcome,
    }).map((labelName) => lookupLabelId(input.labelCatalog, labelName)),
  ];

  return {
    stateId: input.stateId,
    labelIds: [...new Set(labelIds)],
    description: upsertLinearDescriptionMachineState(
      input.issue.description,
      input.descriptionState,
    ),
  };
}

function lookupLabelId(
  labelCatalog: LinearProviderLabelCatalog,
  labelName: string,
): string {
  const record = labelCatalog.get(normalizeLinearLabelName(labelName));

  if (record === undefined) {
    throw new Error(`Missing provider-owned Linear label '${labelName}'.`);
  }

  return record.id;
}

function deriveNextPhase(
  nextStatus: WorkItemStatus,
  requestedPhase: WorkPhaseOrNone,
  currentPhase: WorkPhaseOrNone | null,
): WorkPhaseOrNone {
  if (nextStatus === "done" || nextStatus === "canceled" || nextStatus === "backlog") {
    if (requestedPhase !== "none") {
      throw new Error(`Status '${nextStatus}' must use phase 'none'.`);
    }

    return "none";
  }

  if (nextStatus === "blocked") {
    if (currentPhase === null) {
      throw new Error("Blocked transitions require the current issue phase.");
    }

    return currentPhase;
  }

  if (requestedPhase !== nextStatus) {
    throw new Error(
      `Status '${nextStatus}' must use phase '${nextStatus}', not '${requestedPhase}'.`,
    );
  }

  return requestedPhase;
}
