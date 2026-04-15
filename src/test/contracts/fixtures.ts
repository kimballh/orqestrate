import type {
  ArtifactRecord,
  ProviderError,
  RunLedgerRecord,
  RunStatus,
  WorkItemRecord,
  WorkItemStatus,
  WorkPhaseOrNone,
} from "../../domain-model.js";

type WorkItemFixtureInput = Omit<Partial<WorkItemRecord>, "orchestration"> & {
  id: string;
  orchestration?: Partial<WorkItemRecord["orchestration"]>;
};

export function createWorkItemRecordFixture(
  overrides: WorkItemFixtureInput,
): WorkItemRecord {
  const status = overrides.status ?? "implement";
  const phase =
    overrides.phase ?? derivePhase(status);

  return {
    id: overrides.id,
    identifier: overrides.identifier ?? overrides.id,
    title: overrides.title ?? overrides.id,
    description: overrides.description ?? `Description for ${overrides.id}`,
    status,
    phase,
    priority: overrides.priority ?? 2,
    labels: overrides.labels ?? [],
    url:
      overrides.url ??
      `https://linear.app/orqestrate/issue/${(overrides.identifier ?? overrides.id).toLowerCase()}`,
    parentId: overrides.parentId ?? null,
    dependencyIds: overrides.dependencyIds ?? [],
    blockedByIds: overrides.blockedByIds ?? [],
    blocksIds: overrides.blocksIds ?? [],
    artifactUrl: overrides.artifactUrl ?? null,
    updatedAt: overrides.updatedAt ?? "2026-04-14T00:00:00.000Z",
    createdAt: overrides.createdAt ?? "2026-04-13T23:00:00.000Z",
    orchestration: {
      state: overrides.orchestration?.state ?? "queued",
      owner: overrides.orchestration?.owner ?? null,
      runId: overrides.orchestration?.runId ?? null,
      leaseUntil: overrides.orchestration?.leaseUntil ?? null,
      reviewOutcome: overrides.orchestration?.reviewOutcome ?? "none",
      blockedReason: overrides.orchestration?.blockedReason ?? null,
      lastError: overrides.orchestration?.lastError ?? null,
      attemptCount: overrides.orchestration?.attemptCount ?? 0,
    },
  };
}

export function createProviderErrorFixture(
  overrides: Partial<ProviderError> = {},
): ProviderError {
  return {
    providerFamily: "planning",
    providerKind: "planning.linear",
    code: "validation",
    message: "Contract test provider failure.",
    retryable: false,
    details: null,
    ...overrides,
  };
}

export function createArtifactRecordFixture(
  overrides: Partial<ArtifactRecord> & Pick<ArtifactRecord, "artifactId" | "workItemId">,
): ArtifactRecord {
  return {
    artifactId: overrides.artifactId,
    workItemId: overrides.workItemId,
    title: overrides.title ?? `Artifact for ${overrides.workItemId}`,
    phase: overrides.phase ?? "none",
    state: overrides.state ?? "draft",
    url: overrides.url ?? null,
    summary: overrides.summary ?? null,
    designReady: overrides.designReady ?? false,
    planReady: overrides.planReady ?? false,
    implementationNotesPresent: overrides.implementationNotesPresent ?? false,
    reviewSummaryPresent: overrides.reviewSummaryPresent ?? false,
    verificationEvidencePresent: overrides.verificationEvidencePresent ?? false,
    updatedAt: overrides.updatedAt ?? "2026-04-14T00:00:00.000Z",
    createdAt: overrides.createdAt ?? "2026-04-14T00:00:00.000Z",
  };
}

export function createRunLedgerRecordFixture(
  overrides: Partial<RunLedgerRecord> &
    Pick<RunLedgerRecord, "runId" | "workItemId" | "phase" | "status">,
): RunLedgerRecord {
  return {
    runId: overrides.runId,
    workItemId: overrides.workItemId,
    artifactId: overrides.artifactId ?? null,
    phase: overrides.phase,
    status: overrides.status,
    summary: overrides.summary ?? null,
    verification: overrides.verification ?? null,
    error: overrides.error ?? null,
    startedAt: overrides.startedAt ?? "2026-04-14T00:00:00.000Z",
    endedAt: overrides.endedAt ?? null,
    url: overrides.url ?? null,
    updatedAt: overrides.updatedAt ?? "2026-04-14T00:00:00.000Z",
  };
}

export function createRunId(suffix: string): string {
  return `run-${suffix}`;
}

export function createFutureLease(minutes: string): string {
  return `2099-04-14T01:${minutes.padStart(2, "0")}:00.000Z`;
}

function derivePhase(status: WorkItemStatus): WorkPhaseOrNone {
  switch (status) {
    case "design":
    case "plan":
    case "implement":
    case "review":
      return status;
    case "blocked":
      return "implement";
    case "backlog":
    case "done":
    case "canceled":
      return "none";
  }
}
