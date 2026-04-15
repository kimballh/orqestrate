import assert from "node:assert/strict";
import test from "node:test";

import type { ContextLocalFilesProviderConfig, PlanningLocalFilesProviderConfig } from "../config/types.js";
import {
  ContextBackend,
  type AppendEvidenceInput,
  type ContextBundle,
  type CreateRunLedgerEntryInput,
  type EnsureArtifactInput,
  type FinalizeRunLedgerEntryInput,
  type LoadContextBundleInput,
  type WritePhaseArtifactInput,
} from "../core/context-backend.js";
import {
  PlanningBackend,
  type AppendCommentInput,
  type ClaimWorkItemInput,
  type ListActionableWorkItemsInput,
  type MarkWorkItemRunningInput,
  type RenewLeaseInput,
  type TransitionWorkItemInput,
} from "../core/planning-backend.js";
import type {
  ArtifactRecord,
  RunLedgerRecord,
  WorkItemRecord,
} from "../domain-model.js";
import type { RuntimeReadinessSnapshot } from "../runtime/types.js";

import { Reconciler } from "./reconciler.js";
import type { ObservedRuntimeRun, RuntimeObserver } from "./runtime-observer.js";

test("reconciles a live runtime run by promoting planning to running and renewing the lease", async () => {
  const workItem = createWorkItem({
    orchestration: {
      state: "claimed",
      owner: "orchestrator:test",
      runId: "run-39",
      leaseUntil: "2026-04-15T00:00:10.000Z",
      reviewOutcome: "none",
      blockedReason: null,
      lastError: null,
      attemptCount: 1,
    },
  });
  const planning = new FakePlanningBackend(workItem);
  const context = new FakeContextBackend(createArtifact());
  const runtimeRun = createRuntimeRun({
    runId: "run-39",
    status: "running",
    lastHeartbeatAt: "2026-04-15T00:00:08.000Z",
    lastEventSeq: 6,
  });
  const runtimeObserver = new FakeRuntimeObserver({
    runsById: new Map([[runtimeRun.runId, runtimeRun]]),
  });
  const reconciler = new Reconciler({
    planning,
    context,
    runtimeObserver,
    owner: "orchestrator:test",
    leaseDurationMs: 60_000,
    now: () => new Date("2026-04-15T00:00:09.000Z"),
  });

  const result = await reconciler.reconcileLeasedWorkItem({
    workItem,
    runtimeHealthy: true,
    observation: {
      runId: "run-39",
      workItemId: workItem.id,
      status: "bootstrapping",
      leaseUntil: workItem.orchestration.leaseUntil ?? null,
      lastHeartbeatAt: "2026-04-15T00:00:05.000Z",
      lastEventSeq: 4,
      observedAt: "2026-04-15T00:00:05.000Z",
    },
  });

  assert.equal(result.classification.kind, "planning_active_runtime_active");
  assert.equal(result.promotedToRunning, true);
  assert.equal(result.renewed, true);
  assert.equal(planning.markRunningCalls.length, 1);
  assert.equal(planning.renewLeaseCalls.length, 1);
  assert.equal(result.workItem?.orchestration.state, "running");
});

test("reconciles an expired lease without a live runtime run back to failed and reclaimable", async () => {
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
  const planning = new FakePlanningBackend(workItem);
  const context = new FakeContextBackend(createArtifact());
  const runtimeObserver = new FakeRuntimeObserver();
  const reconciler = new Reconciler({
    planning,
    context,
    runtimeObserver,
    owner: "orchestrator:test",
    leaseDurationMs: 60_000,
    now: () => new Date("2026-04-15T00:00:09.000Z"),
  });

  const result = await reconciler.reconcileLeasedWorkItem({
    workItem,
    runtimeHealthy: true,
  });

  assert.equal(result.classification.kind, "planning_active_runtime_missing_expired_lease");
  assert.equal(context.createRunLedgerCalls.length, 1);
  assert.equal(context.finalizeRunLedgerCalls[0]?.status, "stale");
  assert.equal(planning.transitionCalls[0]?.state, "failed");
  assert.equal(result.handledOutcome, true);
});

test("reconciles waiting_human runtime state into a blocked planning state", async () => {
  const workItem = createWorkItem({
    orchestration: {
      state: "running",
      owner: "orchestrator:test",
      runId: "run-39",
      leaseUntil: "2026-04-15T00:00:10.000Z",
      reviewOutcome: "none",
      blockedReason: null,
      lastError: null,
      attemptCount: 1,
    },
  });
  const planning = new FakePlanningBackend(workItem);
  const context = new FakeContextBackend(createArtifact(), {
    ledgers: new Map([
      [
        "run-39",
        {
          runId: "run-39",
          workItemId: workItem.id,
          artifactId: "artifact-39",
          phase: "implement",
          status: "running",
          summary: null,
          verification: null,
          error: null,
          startedAt: "2026-04-15T00:00:00.000Z",
          endedAt: null,
          url: "/tmp/run-39.json",
          updatedAt: "2026-04-15T00:00:00.000Z",
        },
      ],
    ]),
  });
  const runtimeRun = createRuntimeRun({
    runId: "run-39",
    status: "waiting_human",
    waitingHumanReason: "Need a product decision.",
  });
  const runtimeObserver = new FakeRuntimeObserver({
    runsById: new Map([[runtimeRun.runId, runtimeRun]]),
  });
  const reconciler = new Reconciler({
    planning,
    context,
    runtimeObserver,
    owner: "orchestrator:test",
    leaseDurationMs: 60_000,
    now: () => new Date("2026-04-15T00:00:09.000Z"),
  });

  const result = await reconciler.reconcileLeasedWorkItem({
    workItem,
    runtimeHealthy: true,
  });

  assert.equal(result.classification.kind, "planning_active_runtime_waiting_human");
  assert.equal(context.finalizeRunLedgerCalls[0]?.status, "waiting_human");
  assert.equal(planning.transitionCalls[0]?.nextStatus, "blocked");
  assert.equal(planning.transitionCalls[0]?.state, "waiting_human");
  assert.equal(result.workItem?.status, "blocked");
});

test("reconciles completed implement runs by advancing the ticket and clearing the lease", async () => {
  const workItem = createWorkItem({
    phase: "implement",
    status: "implement",
    orchestration: {
      state: "running",
      owner: "orchestrator:test",
      runId: "run-39",
      leaseUntil: "2026-04-15T00:00:10.000Z",
      reviewOutcome: "none",
      blockedReason: null,
      lastError: null,
      attemptCount: 1,
    },
  });
  const planning = new FakePlanningBackend(workItem);
  const context = new FakeContextBackend(createArtifact());
  const runtimeRun = createRuntimeRun({
    runId: "run-39",
    status: "completed",
    outcome: {
      summary: "Recovered successful implement run.",
      error: null,
    },
  });
  const runtimeObserver = new FakeRuntimeObserver({
    runsById: new Map([[runtimeRun.runId, runtimeRun]]),
  });
  const reconciler = new Reconciler({
    planning,
    context,
    runtimeObserver,
    owner: "orchestrator:test",
    leaseDurationMs: 60_000,
    now: () => new Date("2026-04-15T00:00:09.000Z"),
  });

  const result = await reconciler.reconcileLeasedWorkItem({
    workItem,
    runtimeHealthy: true,
  });

  assert.equal(result.classification.kind, "planning_active_runtime_terminal");
  assert.equal(result.handledOutcome, true);
  assert.equal(context.finalizeRunLedgerCalls[0]?.status, "completed");
  assert.equal(planning.transitionCalls[0]?.nextStatus, "review");
  assert.equal(planning.transitionCalls[0]?.state, "queued");
  assert.equal(result.workItem?.status, "review");
  assert.equal(result.workItem?.orchestration.leaseUntil, null);
});

test("reconciles completed approved review runs into queued merge work", async () => {
  const workItem = createWorkItem({
    phase: "review",
    status: "review",
    orchestration: {
      state: "running",
      owner: "orchestrator:test",
      runId: "run-44",
      leaseUntil: "2026-04-15T00:00:10.000Z",
      reviewOutcome: "approved",
      blockedReason: null,
      lastError: null,
      attemptCount: 1,
    },
  });
  const planning = new FakePlanningBackend(workItem);
  const context = new FakeContextBackend(createArtifact());
  const runtimeRun = createRuntimeRun({
    runId: "run-44",
    status: "completed",
    phase: "review",
    outcome: {
      summary: "Recovered successful review run.",
      error: null,
      reviewOutcome: "approved",
    },
  });
  const runtimeObserver = new FakeRuntimeObserver({
    runsById: new Map([[runtimeRun.runId, runtimeRun]]),
  });
  const reconciler = new Reconciler({
    planning,
    context,
    runtimeObserver,
    owner: "orchestrator:test",
    leaseDurationMs: 60_000,
    now: () => new Date("2026-04-15T00:00:09.000Z"),
  });

  const result = await reconciler.reconcileLeasedWorkItem({
    workItem,
    runtimeHealthy: true,
  });

  assert.equal(result.classification.kind, "planning_active_runtime_terminal");
  assert.equal(planning.transitionCalls[0]?.nextStatus, "review");
  assert.equal(planning.transitionCalls[0]?.nextPhase, "merge");
  assert.equal(result.workItem?.phase, "merge");
});

test("treats terminal runs for an older run id as orphaned instead of mutating the current work item", async () => {
  const workItem = createWorkItem({
    orchestration: {
      state: "running",
      owner: "orchestrator:test",
      runId: "run-new",
      leaseUntil: "2026-04-15T00:00:10.000Z",
      reviewOutcome: "none",
      blockedReason: null,
      lastError: null,
      attemptCount: 2,
    },
  });
  const planning = new FakePlanningBackend(workItem);
  const context = new FakeContextBackend(createArtifact());
  const runtimeRun = createRuntimeRun({
    runId: "run-old",
    status: "failed",
    outcome: {
      summary: "Older failed run.",
      error: {
        providerFamily: "runtime",
        providerKind: "codex",
        code: "unknown",
        message: "Older failed run.",
        retryable: true,
        details: null,
      },
    },
  });
  const runtimeObserver = new FakeRuntimeObserver();
  const reconciler = new Reconciler({
    planning,
    context,
    runtimeObserver,
    owner: "orchestrator:test",
    leaseDurationMs: 60_000,
    now: () => new Date("2026-04-15T00:00:09.000Z"),
  });

  const result = await reconciler.reconcileRuntimeRun({
    runtimeRun,
    runtimeHealthy: true,
  });

  assert.equal(result.classification.kind, "runtime_terminal_orphaned");
  assert.equal(result.handledOutcome, false);
  assert.equal(planning.transitionCalls.length, 0);
  assert.equal(context.finalizeRunLedgerCalls.length, 0);
});

class FakePlanningBackend extends PlanningBackend<PlanningLocalFilesProviderConfig> {
  workItem: WorkItemRecord;
  readonly markRunningCalls: MarkWorkItemRunningInput[] = [];
  readonly renewLeaseCalls: RenewLeaseInput[] = [];
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
  async listActionableWorkItems(
    _input: ListActionableWorkItemsInput,
  ): Promise<WorkItemRecord[]> {
    return [structuredClone(this.workItem)];
  }
  async getWorkItem(id: string): Promise<WorkItemRecord | null> {
    return this.workItem.id === id ? structuredClone(this.workItem) : null;
  }
  async claimWorkItem(_input: ClaimWorkItemInput): Promise<WorkItemRecord> {
    throw new Error("not used in test");
  }
  async markWorkItemRunning(input: MarkWorkItemRunningInput): Promise<WorkItemRecord> {
    this.markRunningCalls.push(structuredClone(input));
    this.workItem = {
      ...this.workItem,
      orchestration: {
        ...this.workItem.orchestration,
        state: "running",
        owner: input.owner,
        runId: input.runId,
        leaseUntil: input.leaseUntil,
      },
    };
    return structuredClone(this.workItem);
  }
  async renewLease(input: RenewLeaseInput): Promise<WorkItemRecord> {
    this.renewLeaseCalls.push(structuredClone(input));
    this.workItem = {
      ...this.workItem,
      orchestration: {
        ...this.workItem.orchestration,
        owner: input.owner,
        runId: input.runId,
        leaseUntil: input.leaseUntil,
      },
    };
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
        reviewOutcome: input.reviewOutcome ?? "none",
      },
    };
    return structuredClone(this.workItem);
  }
  async appendComment(_input: AppendCommentInput): Promise<void> {}
  async buildDeepLink(): Promise<string | null> {
    return null;
  }
}

class FakeContextBackend extends ContextBackend<ContextLocalFilesProviderConfig> {
  readonly createRunLedgerCalls: CreateRunLedgerEntryInput[] = [];
  readonly finalizeRunLedgerCalls: FinalizeRunLedgerEntryInput[] = [];
  private readonly ledgers: Map<string, RunLedgerRecord>;

  constructor(
    private readonly artifact: ArtifactRecord,
    options: { ledgers?: Map<string, RunLedgerRecord> } = {},
  ) {
    super({
      name: "context_test",
      kind: "context.local_files",
      family: "context",
      root: "/tmp",
      templates: {},
    });
    this.ledgers = new Map(options.ledgers ?? []);
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
    this.createRunLedgerCalls.push(structuredClone(input));
    const ledger: RunLedgerRecord = {
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
    this.ledgers.set(input.runId, ledger);
    return structuredClone(ledger);
  }
  async getRunLedgerEntry(runId: string): Promise<RunLedgerRecord | null> {
    const ledger = this.ledgers.get(runId);
    return ledger === undefined ? null : structuredClone(ledger);
  }
  async finalizeRunLedgerEntry(input: FinalizeRunLedgerEntryInput): Promise<RunLedgerRecord> {
    this.finalizeRunLedgerCalls.push(structuredClone(input));
    const current = this.ledgers.get(input.runId);

    if (!current) {
      throw new Error(`Run ledger '${input.runId}' does not exist.`);
    }

    const ledger: RunLedgerRecord = {
      ...current,
      status: input.status,
      summary: input.summary ?? current.summary ?? null,
      error: input.error ?? current.error ?? null,
      endedAt: "2026-04-15T00:01:00.000Z",
      updatedAt: "2026-04-15T00:01:00.000Z",
    };
    this.ledgers.set(input.runId, ledger);
    return structuredClone(ledger);
  }
  async appendEvidence(_input: AppendEvidenceInput): Promise<void> {}
}

class FakeRuntimeObserver implements RuntimeObserver {
  private readonly runsById: Map<string, ObservedRuntimeRun>;
  private readonly health: RuntimeReadinessSnapshot;

  constructor(options: {
    runsById?: Map<string, ObservedRuntimeRun>;
    health?: RuntimeReadinessSnapshot;
  } = {}) {
    this.runsById = new Map(options.runsById ?? []);
    this.health = options.health ?? {
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

  async getRun(runId: string): Promise<ObservedRuntimeRun | null> {
    return this.runsById.get(runId) ?? null;
  }
  async listRuns(): Promise<{ runs: ObservedRuntimeRun[]; nextCursor?: string | null }> {
    return { runs: [...this.runsById.values()], nextCursor: null };
  }
  async listRunEvents(): Promise<[]> {
    return [];
  }
  async getHealth(): Promise<RuntimeReadinessSnapshot> {
    return this.health;
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
      leaseUntil: "2026-04-15T00:00:10.000Z",
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
    grantedCapabilities: overrides.grantedCapabilities ?? [],
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
    completedAt: overrides.completedAt ?? null,
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
