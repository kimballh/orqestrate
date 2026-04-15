import assert from "node:assert/strict";
import test from "node:test";

import type { ContextLocalFilesProviderConfig, PlanningLocalFilesProviderConfig } from "../config/types.js";
import { ContextBackend, type AppendEvidenceInput, type ContextBundle, type CreateRunLedgerEntryInput, type EnsureArtifactInput, type FinalizeRunLedgerEntryInput, type LoadContextBundleInput, type WritePhaseArtifactInput } from "../core/context-backend.js";
import { PlanningBackend, type AppendCommentInput, type ClaimWorkItemInput, type ListActionableWorkItemsInput, type MarkWorkItemRunningInput, type RenewLeaseInput, type TransitionWorkItemInput } from "../core/planning-backend.js";
import type { ArtifactRecord, RunLedgerRecord, WorkItemRecord } from "../domain-model.js";
import type { RuntimeReadinessSnapshot } from "../runtime/types.js";

import { ReconciliationLoop } from "./reconciliation-loop.js";
import type { ObservedRuntimeRun, RuntimeObserver } from "./runtime-observer.js";

test("fast ticks reconcile tracked work items and stop tracking terminal outcomes", async () => {
  const workItem = createWorkItem({
    orchestration: {
      state: "running",
      owner: "orchestrator:test",
      runId: "run-39",
      leaseUntil: "2026-04-15T00:00:05.000Z",
      reviewOutcome: "none",
      blockedReason: null,
      lastError: null,
      attemptCount: 1,
    },
  });
  const planning = new LoopPlanningBackend(workItem);
  const context = new LoopContextBackend(createArtifact());
  const runtimeRun = createRuntimeRun({
    runId: "run-39",
    status: "stale",
    outcome: {
      summary: "Recovered stale run.",
      error: {
        providerFamily: "runtime",
        providerKind: "reconciler",
        code: "unavailable",
        message: "Recovered stale run.",
        retryable: true,
        details: null,
      },
    },
  });
  const runtimeObserver = new LoopRuntimeObserver({
    runsById: new Map([[runtimeRun.runId, runtimeRun]]),
  });
  const loop = new ReconciliationLoop({
    planning,
    context,
    runtimeObserver,
    owner: "orchestrator:test",
    leaseDurationMs: 60_000,
    now: () => new Date("2026-04-15T00:00:09.000Z"),
  });

  loop.trackWorkItem(workItem.id);

  const results = await loop.runFastTick();

  assert.equal(results.length, 1);
  assert.equal(results[0]?.handledOutcome, true);
  assert.equal(planning.transitionCalls.length, 1);
  assert.equal(context.finalizeRunLedgerCalls[0]?.status, "stale");

  const secondResults = await loop.runFastTick();
  assert.equal(secondResults.length, 0);
});

test("drift ticks reconcile terminal runtime runs even without a tracked work item id", async () => {
  const workItem = createWorkItem({
    orchestration: {
      state: "idle",
      owner: null,
      runId: null,
      leaseUntil: null,
      reviewOutcome: "none",
      blockedReason: null,
      lastError: null,
      attemptCount: 0,
    },
  });
  const planning = new LoopPlanningBackend(workItem);
  const context = new LoopContextBackend(createArtifact());
  const runtimeRun = createRuntimeRun({
    runId: "run-39",
    status: "failed",
    outcome: {
      summary: "Runtime failed after restart.",
      error: {
        providerFamily: "runtime",
        providerKind: "codex",
        code: "unknown",
        message: "Runtime failed after restart.",
        retryable: true,
        details: null,
      },
    },
  });
  const runtimeObserver = new LoopRuntimeObserver({
    pageByStatus: new Map([["failed", [runtimeRun]]]),
  });
  const loop = new ReconciliationLoop({
    planning,
    context,
    runtimeObserver,
    owner: "orchestrator:test",
    leaseDurationMs: 60_000,
    now: () => new Date("2026-04-15T00:00:09.000Z"),
  });

  const results = await loop.runDriftTick();

  assert.equal(results.length >= 1, true);
  assert.equal(context.finalizeRunLedgerCalls.length, 0);
  assert.equal(planning.transitionCalls.length, 0);
});

test("drift ticks page through runtime status buckets until all results are consumed", async () => {
  const workItem = createWorkItem({
    orchestration: {
      state: "idle",
      owner: null,
      runId: null,
      leaseUntil: null,
      reviewOutcome: "none",
      blockedReason: null,
      lastError: null,
      attemptCount: 0,
    },
  });
  const planning = new LoopPlanningBackend(workItem);
  const context = new LoopContextBackend(createArtifact());
  const firstRun = createRuntimeRun({
    runId: "run-page-1",
    status: "failed",
    outcome: {
      summary: "Page one failed run.",
      error: {
        providerFamily: "runtime",
        providerKind: "codex",
        code: "unknown",
        message: "Page one failed run.",
        retryable: true,
        details: null,
      },
    },
  });
  const secondRun = createRuntimeRun({
    runId: "run-page-2",
    status: "failed",
    outcome: {
      summary: "Page two failed run.",
      error: {
        providerFamily: "runtime",
        providerKind: "codex",
        code: "unknown",
        message: "Page two failed run.",
        retryable: true,
        details: null,
      },
    },
  });
  const runtimeObserver = new LoopRuntimeObserver({
    pagedByStatus: new Map([
      [
        "failed",
        [
          {
            runs: [firstRun],
            nextCursor: "cursor-2",
          },
          {
            runs: [secondRun],
            nextCursor: null,
          },
        ],
      ],
    ]),
  });
  const loop = new ReconciliationLoop({
    planning,
    context,
    runtimeObserver,
    owner: "orchestrator:test",
    leaseDurationMs: 60_000,
    now: () => new Date("2026-04-15T00:00:09.000Z"),
  });

  const results = await loop.runDriftTick();

  assert.equal(results.length >= 2, true);
  assert.equal(runtimeObserver.listRunsCalls.filter((call) => call.status === "failed").length, 2);
});

class LoopPlanningBackend extends PlanningBackend<PlanningLocalFilesProviderConfig> {
  workItem: WorkItemRecord;
  readonly transitionCalls: TransitionWorkItemInput[] = [];

  constructor(workItem: WorkItemRecord) {
    super({
      name: "planning_test",
      kind: "planning.local_files",
      family: "planning",
      root: "/tmp",
    });
    this.workItem = structuredClone(workItem);
  }

  async validateConfig(): Promise<void> {}
  async healthCheck(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
  async listActionableWorkItems(_input: ListActionableWorkItemsInput): Promise<WorkItemRecord[]> {
    return [structuredClone(this.workItem)];
  }
  async getWorkItem(id: string): Promise<WorkItemRecord | null> {
    return this.workItem.id === id ? structuredClone(this.workItem) : null;
  }
  async claimWorkItem(_input: ClaimWorkItemInput): Promise<WorkItemRecord> {
    throw new Error("not used");
  }
  async markWorkItemRunning(_input: MarkWorkItemRunningInput): Promise<WorkItemRecord> {
    return structuredClone(this.workItem);
  }
  async renewLease(_input: RenewLeaseInput): Promise<WorkItemRecord> {
    return structuredClone(this.workItem);
  }
  async transitionWorkItem(input: TransitionWorkItemInput): Promise<WorkItemRecord> {
    this.transitionCalls.push(structuredClone(input));
    this.workItem = {
      ...this.workItem,
      status: input.nextStatus,
      phase: input.nextPhase,
      orchestration: {
        ...this.workItem.orchestration,
        state: input.state,
        owner: null,
        runId: input.runId ?? null,
        leaseUntil: null,
        blockedReason: input.blockedReason ?? null,
        lastError: input.lastError ?? null,
      },
    };
    return structuredClone(this.workItem);
  }
  async appendComment(_input: AppendCommentInput): Promise<void> {}
  async buildDeepLink(): Promise<string | null> {
    return null;
  }
}

class LoopContextBackend extends ContextBackend<ContextLocalFilesProviderConfig> {
  readonly finalizeRunLedgerCalls: FinalizeRunLedgerEntryInput[] = [];
  private readonly ledgers = new Map<string, RunLedgerRecord>();

  constructor(private readonly artifact: ArtifactRecord) {
    super({
      name: "context_test",
      kind: "context.local_files",
      family: "context",
      root: "/tmp",
      templates: {},
    });
  }

  async validateConfig(): Promise<void> {}
  async healthCheck(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
  async ensureArtifact(_input: EnsureArtifactInput): Promise<ArtifactRecord> {
    return structuredClone(this.artifact);
  }
  async getArtifactByWorkItemId(workItemId: string): Promise<ArtifactRecord | null> {
    return workItemId === this.artifact.workItemId ? structuredClone(this.artifact) : null;
  }
  async loadContextBundle(_input: LoadContextBundleInput): Promise<ContextBundle> {
    return { artifact: structuredClone(this.artifact), contextText: "", references: [] };
  }
  async writePhaseArtifact(_input: WritePhaseArtifactInput): Promise<ArtifactRecord> {
    return structuredClone(this.artifact);
  }
  async createRunLedgerEntry(input: CreateRunLedgerEntryInput): Promise<RunLedgerRecord> {
    const record: RunLedgerRecord = {
      runId: input.runId,
      workItemId: input.workItem.id,
      artifactId: this.artifact.artifactId,
      phase: input.phase,
      status: input.status,
      summary: null,
      verification: null,
      error: null,
      startedAt: "2026-04-15T00:00:00.000Z",
      endedAt: null,
      url: `/tmp/${input.runId}.json`,
      updatedAt: "2026-04-15T00:00:00.000Z",
    };
    this.ledgers.set(input.runId, record);
    return structuredClone(record);
  }
  async getRunLedgerEntry(runId: string): Promise<RunLedgerRecord | null> {
    return this.ledgers.get(runId) ?? null;
  }
  async finalizeRunLedgerEntry(input: FinalizeRunLedgerEntryInput): Promise<RunLedgerRecord> {
    this.finalizeRunLedgerCalls.push(structuredClone(input));
    const current =
      this.ledgers.get(input.runId) ??
      ({
        runId: input.runId,
        workItemId: this.artifact.workItemId,
        artifactId: this.artifact.artifactId,
        phase: "implement",
        status: "running",
        summary: null,
        verification: null,
        error: null,
        startedAt: "2026-04-15T00:00:00.000Z",
        endedAt: null,
        url: `/tmp/${input.runId}.json`,
        updatedAt: "2026-04-15T00:00:00.000Z",
      } satisfies RunLedgerRecord);
    const next = {
      ...current,
      status: input.status,
      summary: input.summary ?? current.summary ?? null,
      error: input.error ?? current.error ?? null,
      endedAt: "2026-04-15T00:01:00.000Z",
      updatedAt: "2026-04-15T00:01:00.000Z",
    };
    this.ledgers.set(input.runId, next);
    return structuredClone(next);
  }
  async appendEvidence(_input: AppendEvidenceInput): Promise<void> {}
}

class LoopRuntimeObserver implements RuntimeObserver {
  readonly listRunsCalls: Array<{ status?: string; cursor?: string }> = [];
  constructor(
    private readonly options: {
      runsById?: Map<string, ObservedRuntimeRun>;
      pageByStatus?: Map<string, ObservedRuntimeRun[]>;
      pagedByStatus?: Map<
        string,
        Array<{ runs: ObservedRuntimeRun[]; nextCursor?: string | null }>
      >;
      health?: RuntimeReadinessSnapshot;
    } = {},
  ) {}

  async getRun(runId: string): Promise<ObservedRuntimeRun | null> {
    return this.options.runsById?.get(runId) ?? null;
  }
  async listRuns(input: { status?: string; cursor?: string }): Promise<{ runs: ObservedRuntimeRun[]; nextCursor?: string | null }> {
    this.listRunsCalls.push({ status: input.status, cursor: input.cursor });

    if (input.status !== undefined) {
      const pagedResults = this.options.pagedByStatus?.get(input.status);

      if (pagedResults !== undefined) {
        if (input.cursor === undefined) {
          return pagedResults[0] ?? { runs: [], nextCursor: null };
        }

        const nextIndex = pagedResults.findIndex(
          (page) => page.nextCursor === input.cursor,
        );

        if (nextIndex >= 0 && pagedResults[nextIndex + 1] !== undefined) {
          return pagedResults[nextIndex + 1];
        }

        return { runs: [], nextCursor: null };
      }
    }

    return {
      runs: input.status === undefined ? [] : (this.options.pageByStatus?.get(input.status) ?? []),
      nextCursor: null,
    };
  }
  async listRunEvents(): Promise<[]> {
    return [];
  }
  async getHealth(): Promise<RuntimeReadinessSnapshot> {
    return this.options.health ?? {
      ok: true,
      profile: "test",
      checks: {
        database: { ok: true },
        dispatcher: { ok: true },
        transport: { ok: true },
        adapters: { ok: true, providers: ["codex"] },
      },
    };
  }
}

function createWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: overrides.id ?? "ORQ-39",
    identifier: overrides.identifier ?? "ORQ-39",
    title: overrides.title ?? "Implement poll-based reconciliation",
    description: overrides.description ?? null,
    status: overrides.status ?? "implement",
    phase: overrides.phase ?? "implement",
    priority: overrides.priority ?? 1,
    labels: overrides.labels ?? [],
    url: overrides.url ?? "https://linear.app/orqestrate/issue/ORQ-39",
    parentId: overrides.parentId ?? null,
    dependencyIds: overrides.dependencyIds ?? [],
    blockedByIds: overrides.blockedByIds ?? [],
    blocksIds: overrides.blocksIds ?? [],
    artifactUrl: overrides.artifactUrl ?? null,
    updatedAt: overrides.updatedAt ?? "2026-04-15T00:00:00.000Z",
    createdAt: overrides.createdAt ?? "2026-04-14T00:00:00.000Z",
    orchestration: overrides.orchestration ?? {
      state: "running",
      owner: "orchestrator:test",
      runId: "run-39",
      leaseUntil: "2026-04-15T00:00:05.000Z",
      reviewOutcome: "none",
      blockedReason: null,
      lastError: null,
      attemptCount: 1,
    },
  };
}

function createArtifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    artifactId: overrides.artifactId ?? "artifact-39",
    workItemId: overrides.workItemId ?? "ORQ-39",
    title: overrides.title ?? "ORQ-39 Artifact",
    phase: overrides.phase ?? "implement",
    state: overrides.state ?? "ready",
    url: overrides.url ?? "https://www.notion.so/orq-39",
    summary: overrides.summary ?? "Artifact exists.",
    designReady: overrides.designReady ?? true,
    planReady: overrides.planReady ?? true,
    implementationNotesPresent: overrides.implementationNotesPresent ?? false,
    reviewSummaryPresent: overrides.reviewSummaryPresent ?? false,
    verificationEvidencePresent: overrides.verificationEvidencePresent ?? false,
    updatedAt: overrides.updatedAt ?? "2026-04-15T00:00:00.000Z",
    createdAt: overrides.createdAt ?? "2026-04-14T00:00:00.000Z",
  };
}

function createRuntimeRun(
  overrides: Partial<ObservedRuntimeRun> = {},
): ObservedRuntimeRun {
  return {
    runId: overrides.runId ?? "run-39",
    workItemId: overrides.workItemId ?? "ORQ-39",
    workItemIdentifier: overrides.workItemIdentifier ?? "ORQ-39",
    phase: overrides.phase ?? "implement",
    provider: overrides.provider ?? "codex",
    status: overrides.status ?? "running",
    repoRoot: overrides.repoRoot ?? "/tmp/orqestrate",
    workspace: overrides.workspace ?? { mode: "ephemeral_worktree" },
    artifactUrl: overrides.artifactUrl ?? null,
    requestedBy: overrides.requestedBy ?? null,
    promptContractId: overrides.promptContractId ?? "orqestrate/implement/v1",
    promptDigests: overrides.promptDigests ?? { system: null, user: "digest" },
    limits: overrides.limits ?? {
      maxWallTimeSec: 3600,
      idleTimeoutSec: 300,
      bootstrapTimeoutSec: 120,
    },
    outcome: overrides.outcome ?? null,
    createdAt: overrides.createdAt ?? "2026-04-15T00:00:00.000Z",
    admittedAt: overrides.admittedAt ?? "2026-04-15T00:00:01.000Z",
    startedAt: overrides.startedAt ?? "2026-04-15T00:00:02.000Z",
    completedAt: overrides.completedAt ?? "2026-04-15T00:00:10.000Z",
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? "2026-04-15T00:00:05.000Z",
    lastEventSeq: overrides.lastEventSeq ?? 5,
    priority: overrides.priority ?? 100,
    runtimeOwner: overrides.runtimeOwner ?? "runtime-daemon:test",
    attemptCount: overrides.attemptCount ?? 1,
    waitingHumanReason: overrides.waitingHumanReason ?? null,
    readyAt: overrides.readyAt ?? "2026-04-15T00:00:03.000Z",
    version: overrides.version ?? 1,
  };
}
