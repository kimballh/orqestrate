import type { WorkItemRecord, WorkItemStatus, WorkPhaseOrNone } from "../../../domain-model.js";

import type {
  LinearHydratedIssueRecord,
  LinearIssueReferenceRecord,
  LinearWorkflowStateRecord,
} from "./client.js";
import type { LinearPlanningConfigAdapter } from "./config-adapter.js";
import { readLinearMachineState } from "./machine-state/index.js";

const TERMINAL_STATUSES = new Set<WorkItemStatus>(["done", "canceled"]);
const TERMINAL_LINEAR_STATE_TYPES = new Set(["completed", "canceled"]);

export function mapLinearIssueToWorkItem(
  issue: LinearHydratedIssueRecord,
  adapter: LinearPlanningConfigAdapter,
): WorkItemRecord {
  const machineState = readLinearMachineState({
    id: issue.id,
    identifier: issue.identifier,
    labels: issue.labels.map((label) => label.name),
    description: issue.description,
  });
  const status = resolveCanonicalStatus(issue.state, adapter);
  const phase = resolvePhase(status, machineState.phase);
  const relations = mapRelations(issue);

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: machineState.description,
    status,
    phase,
    priority: issue.priority,
    labels: issue.labels.map((label) => label.name),
    url: issue.url,
    parentId: issue.parent?.identifier ?? issue.parent?.id ?? null,
    dependencyIds: relations.dependencyIds,
    blockedByIds: relations.blockedByIds,
    blocksIds: relations.blocksIds,
    artifactUrl: machineState.artifactUrl,
    updatedAt: issue.updatedAt,
    createdAt: issue.createdAt,
    orchestration: {
      state: machineState.state ?? "idle",
      owner: machineState.owner,
      runId: machineState.runId,
      leaseUntil: machineState.leaseUntil,
      reviewOutcome: machineState.reviewOutcome ?? "none",
      blockedReason: machineState.blockedReason,
      lastError: machineState.lastError,
      attemptCount: machineState.attemptCount,
    },
  };
}

export function compareWorkItems(
  left: WorkItemRecord,
  right: WorkItemRecord,
): number {
  const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER;
  const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER;

  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  const updatedAtComparison =
    Date.parse(left.updatedAt) - Date.parse(right.updatedAt);

  if (updatedAtComparison !== 0) {
    return updatedAtComparison;
  }

  return left.id.localeCompare(right.id);
}

function resolveCanonicalStatus(
  state: LinearWorkflowStateRecord,
  adapter: LinearPlanningConfigAdapter,
): WorkItemStatus {
  const entry = (
    Object.entries(adapter.workflowStates) as Array<[
      WorkItemStatus,
      LinearWorkflowStateRecord,
    ]>
  ).find(
    ([, workflowState]) =>
      workflowState.id === state.id ||
      stringsEqual(workflowState.name, state.name),
  );

  if (entry === undefined) {
    throw new Error(
      `Linear workflow state '${state.name}' is not mapped in provider '${adapter.provider.name}'.`,
    );
  }

  return entry[0];
}

function resolvePhase(
  status: WorkItemStatus,
  harnessPhase: WorkPhaseOrNone | null,
): WorkPhaseOrNone {
  if (harnessPhase !== null) {
    return harnessPhase;
  }

  switch (status) {
    case "design":
    case "plan":
    case "implement":
    case "review":
      return status;
    case "backlog":
    case "blocked":
    case "done":
    case "canceled":
      return "none";
  }
}

function mapRelations(issue: LinearHydratedIssueRecord): {
  dependencyIds: string[];
  blockedByIds: string[];
  blocksIds: string[];
} {
  const dependencyIds: string[] = [];
  const blockedByIds: string[] = [];
  const blocksIds: string[] = [];

  for (const relation of issue.relations) {
    if (!stringsEqual(relation.type, "blocks")) {
      continue;
    }

    pushUnique(blocksIds, relation.relatedIssue.identifier ?? relation.relatedIssue.id);
  }

  for (const relation of issue.inverseRelations) {
    if (!stringsEqual(relation.type, "blocks")) {
      continue;
    }

    const blockerId = relation.issue.identifier ?? relation.issue.id;
    pushUnique(dependencyIds, blockerId);

    if (isOpenBlocker(relation.issue)) {
      pushUnique(blockedByIds, blockerId);
    }
  }

  return {
    dependencyIds,
    blockedByIds,
    blocksIds,
  };
}

function isOpenBlocker(issue: LinearIssueReferenceRecord): boolean {
  if (issue.status === null) {
    return true;
  }

  if (TERMINAL_LINEAR_STATE_TYPES.has(issue.status.type.trim().toLowerCase())) {
    return false;
  }

  return !TERMINAL_STATUSES.has(issue.status.name.trim().toLowerCase() as WorkItemStatus);
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function stringsEqual(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}
