import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../config/loader.js";
import type {
  ContextLocalFilesProviderConfig,
  LoadedConfig,
  PlanningLocalFilesProviderConfig,
} from "../config/types.js";
import type {
  ArtifactRecord,
  RunLedgerRecord,
  VerificationSummary,
  WorkItemRecord,
} from "../domain-model.js";
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
import type { CreateRunResponse, RuntimeApiRun } from "../runtime/api/types.js";
import type { RunEventRecord } from "../runtime/types.js";

import { executeClaimedRun, executePreparedRun } from "./execute-run.js";
import type { RuntimeClient } from "./runtime-client.js";
import type { PreparedOrchestrationRun } from "./types.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("executeClaimedRun prepares, submits, watches, and writes back a completed implement run", async () => {
  const loadedConfig = await loadLocalConfig();
  const workItem = createWorkItem();
  const artifact = createArtifact();
  const planning = new FakePlanningBackend(workItem);
  const context = new FakeContextBackend(artifact);
  const runtime = new FakeRuntimeClient({
    createRun: createRuntimeRun({
      runId: "run-38",
      workItemId: workItem.id,
      workItemIdentifier: workItem.identifier ?? null,
      phase: "implement",
      provider: "codex",
      status: "queued",
      repoRoot: REPO_ROOT,
      artifactUrl: artifact.url ?? null,
      lastEventSeq: 1,
    }),
    runs: [
      createRuntimeRun({
        runId: "run-38",
        workItemId: workItem.id,
        workItemIdentifier: workItem.identifier ?? null,
        phase: "implement",
        provider: "codex",
        status: "bootstrapping",
        repoRoot: REPO_ROOT,
        artifactUrl: artifact.url ?? null,
        lastEventSeq: 1,
      }),
      createRuntimeRun({
        runId: "run-38",
        workItemId: workItem.id,
        workItemIdentifier: workItem.identifier ?? null,
        phase: "implement",
        provider: "codex",
        status: "running",
        repoRoot: REPO_ROOT,
        artifactUrl: artifact.url ?? null,
        lastEventSeq: 2,
      }),
      createRuntimeRun({
        runId: "run-38",
        workItemId: workItem.id,
        workItemIdentifier: workItem.identifier ?? null,
        phase: "implement",
        provider: "codex",
        status: "completed",
        repoRoot: REPO_ROOT,
        artifactUrl: artifact.url ?? null,
        lastEventSeq: 3,
        outcome: {
          code: "completed",
          summary: "Implementation landed cleanly.",
          details: "Touched the runtime client, monitor, and write-back policy.",
          verification: {
            commands: ["npm run test"],
            passed: true,
            notes: "npm run test passed",
          },
          artifactMarkdown:
            "## Implementation Summary\n\n- Added runtime submission flow.\n- Added outcome write-back.",
        },
      }),
    ],
    events: [[], []],
  });
  const now = createNowSequence([
    "2026-04-15T00:00:10.000Z",
    "2026-04-15T00:00:55.000Z",
    "2026-04-15T00:01:20.000Z",
  ]);

  const result = await executeClaimedRun(
    {
      planning,
      context,
      loadedConfig,
      runtime,
      now,
      eventPollWaitMs: 0,
      leaseSafetyWindowMs: 15_000,
    },
    {
      workItemId: workItem.id,
      provider: "codex",
      repoRoot: REPO_ROOT,
      owner: "orchestrator:test",
      createRunId: () => "run-38",
      now: new Date("2026-04-15T00:00:00.000Z"),
      leaseDurationMs: 60_000,
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok || !("execution" in result)) {
    assert.fail("Expected executeClaimedRun to complete successfully.");
  }

  assert.equal(planning.claimCalls.length, 1);
  assert.equal(planning.markRunningCalls.length, 1);
  assert.equal(planning.renewLeaseCalls.length, 1);
  assert.equal(planning.transitionCalls.at(-1)?.nextStatus, "review");
  assert.equal(context.writePhaseArtifactCalls.length, 1);
  assert.equal(context.finalizeRunLedgerCalls.at(-1)?.status, "completed");
  assert.deepEqual(context.finalizeRunLedgerCalls.at(-1)?.verification, {
    commands: ["npm run test"],
    passed: true,
    notes: "npm run test passed",
  });
  assert.deepEqual(context.operationLog.slice(-3), [
    "write_phase_artifact",
    "append_evidence",
    "finalize_run_ledger",
  ]);
  assert.equal(planning.operationLog.at(-2), "transition_work_item");
  assert.equal(planning.operationLog.at(-1), "append_comment");
  assert.match(
    context.writePhaseArtifactCalls[0]?.content ?? "",
    /Implementation Summary/,
  );
  assert.match(planning.comments[0]?.body ?? "", /Implementation landed cleanly/);
});

test("executePreparedRun hands waiting-human runs back as blocked work", async () => {
  const loadedConfig = await loadLocalConfig();
  const workItem = createWorkItem();
  const artifact = createArtifact();
  const planning = new FakePlanningBackend(workItem);
  const context = new FakeContextBackend(artifact);
  const prepared = createPreparedRun(workItem, artifact);
  const runtime = new FakeRuntimeClient({
    createRun: createRuntimeRun({
      runId: prepared.runId,
      workItemId: workItem.id,
      workItemIdentifier: workItem.identifier ?? null,
      phase: "implement",
      provider: "codex",
      status: "queued",
      repoRoot: REPO_ROOT,
      artifactUrl: artifact.url ?? null,
      lastEventSeq: 1,
    }),
    runs: [
      createRuntimeRun({
        runId: prepared.runId,
        workItemId: workItem.id,
        workItemIdentifier: workItem.identifier ?? null,
        phase: "implement",
        provider: "codex",
        status: "waiting_human",
        repoRoot: REPO_ROOT,
        artifactUrl: artifact.url ?? null,
        waitingHumanReason: "Need operator confirmation before updating Linear.",
        lastEventSeq: 2,
      }),
    ],
    events: [[]],
  });

  const result = await executePreparedRun(
    {
      planning,
      context,
      loadedConfig,
      runtime,
      now: () => new Date("2026-04-15T00:00:00.000Z"),
      eventPollWaitMs: 0,
      leaseSafetyWindowMs: 15_000,
    },
    prepared,
  );

  assert.equal(result.writeback.workItem.status, "blocked");
  assert.equal(result.writeback.workItem.orchestration.state, "waiting_human");
  assert.equal(context.finalizeRunLedgerCalls.at(-1)?.status, "waiting_human");
  assert.equal(context.writePhaseArtifactCalls.length, 0);
  assert.match(
    planning.comments[0]?.body ?? "",
    /waiting for human input/i,
  );
});

test("executePreparedRun renews the claim lease before the runtime reaches a live state", async () => {
  const loadedConfig = await loadLocalConfig();
  const workItem = createWorkItem();
  const artifact = createArtifact();
  const planning = new FakePlanningBackend(workItem);
  const context = new FakeContextBackend(artifact);
  const prepared = createPreparedRun(workItem, artifact);
  const runtime = new FakeRuntimeClient({
    createRun: createRuntimeRun({
      runId: prepared.runId,
      workItemId: workItem.id,
      workItemIdentifier: workItem.identifier ?? null,
      phase: "implement",
      provider: "codex",
      status: "queued",
      repoRoot: REPO_ROOT,
      artifactUrl: artifact.url ?? null,
      lastEventSeq: 1,
    }),
    runs: [
      createRuntimeRun({
        runId: prepared.runId,
        workItemId: workItem.id,
        workItemIdentifier: workItem.identifier ?? null,
        phase: "implement",
        provider: "codex",
        status: "queued",
        repoRoot: REPO_ROOT,
        artifactUrl: artifact.url ?? null,
        lastEventSeq: 1,
      }),
      createRuntimeRun({
        runId: prepared.runId,
        workItemId: workItem.id,
        workItemIdentifier: workItem.identifier ?? null,
        phase: "implement",
        provider: "codex",
        status: "bootstrapping",
        repoRoot: REPO_ROOT,
        artifactUrl: artifact.url ?? null,
        lastEventSeq: 2,
      }),
      createRuntimeRun({
        runId: prepared.runId,
        workItemId: workItem.id,
        workItemIdentifier: workItem.identifier ?? null,
        phase: "implement",
        provider: "codex",
        status: "completed",
        repoRoot: REPO_ROOT,
        artifactUrl: artifact.url ?? null,
        lastEventSeq: 3,
        outcome: {
          code: "completed",
          summary: "Completed after a long queue wait.",
        },
      }),
    ],
    events: [[], []],
  });
  const now = createNowSequence([
    "2026-04-15T00:00:50.000Z",
    "2026-04-15T00:01:05.000Z",
    "2026-04-15T00:01:10.000Z",
  ]);

  await executePreparedRun(
    {
      planning,
      context,
      loadedConfig,
      runtime,
      now,
      eventPollWaitMs: 0,
      leaseSafetyWindowMs: 15_000,
    },
    prepared,
  );

  assert.equal(planning.renewLeaseCalls.length, 1);
  assert.equal(planning.markRunningCalls.length, 1);
  assert.equal(
    planning.renewLeaseCalls[0]?.leaseUntil,
    "2026-04-15T00:01:50.000Z",
  );
});

test("executePreparedRun does not rewrite partial write-back failures as retryable runtime failures", async () => {
  const loadedConfig = await loadLocalConfig();
  const workItem = createWorkItem();
  const artifact = createArtifact();
  const planning = new FakePlanningBackend(workItem, {
    failAppendComment: new Error("planning comment write failed"),
  });
  const context = new FakeContextBackend(artifact);
  const prepared = createPreparedRun(workItem, artifact);
  const runtime = new FakeRuntimeClient({
    createRun: createRuntimeRun({
      runId: prepared.runId,
      workItemId: workItem.id,
      workItemIdentifier: workItem.identifier ?? null,
      phase: "implement",
      provider: "codex",
      status: "queued",
      repoRoot: REPO_ROOT,
      artifactUrl: artifact.url ?? null,
      lastEventSeq: 1,
    }),
    runs: [
      createRuntimeRun({
        runId: prepared.runId,
        workItemId: workItem.id,
        workItemIdentifier: workItem.identifier ?? null,
        phase: "implement",
        provider: "codex",
        status: "bootstrapping",
        repoRoot: REPO_ROOT,
        artifactUrl: artifact.url ?? null,
        lastEventSeq: 1,
      }),
      createRuntimeRun({
        runId: prepared.runId,
        workItemId: workItem.id,
        workItemIdentifier: workItem.identifier ?? null,
        phase: "implement",
        provider: "codex",
        status: "completed",
        repoRoot: REPO_ROOT,
        artifactUrl: artifact.url ?? null,
        lastEventSeq: 2,
        outcome: {
          code: "completed",
          summary: "Implementation landed before comment write failed.",
          artifactMarkdown: "## Implementation Summary\n\n- landed",
        },
      }),
    ],
    events: [[]],
  });

  await assert.rejects(
    () =>
      executePreparedRun(
        {
          planning,
          context,
          loadedConfig,
          runtime,
          now: () => new Date("2026-04-15T00:00:10.000Z"),
          eventPollWaitMs: 0,
          leaseSafetyWindowMs: 15_000,
        },
        prepared,
      ),
    /planning comment write failed/,
  );

  assert.equal(context.finalizeRunLedgerCalls.length, 1);
  assert.equal(context.finalizeRunLedgerCalls[0]?.status, "completed");
  assert.equal(planning.transitionCalls.length, 1);
  assert.equal(planning.transitionCalls[0]?.nextStatus, "review");
});

async function loadLocalConfig(): Promise<LoadedConfig> {
  return loadConfig({
    configPath: path.join(REPO_ROOT, "docs/config.example.toml"),
    cwd: REPO_ROOT,
  });
}

class FakeRuntimeClient implements RuntimeClient {
  private readonly queuedRuns: RuntimeApiRun[];
  private readonly queuedEvents: RunEventRecord[][];

  constructor(options: {
    createRun: RuntimeApiRun;
    runs: RuntimeApiRun[];
    events: RunEventRecord[][];
  }) {
    this.createRunResponse = options.createRun;
    this.queuedRuns = [...options.runs];
    this.queuedEvents = [...options.events];
  }

  private readonly createRunResponse: RuntimeApiRun;

  async createRun(): Promise<CreateRunResponse> {
    return {
      created: true,
      run: structuredClone(this.createRunResponse),
    };
  }

  async getRun(): Promise<RuntimeApiRun> {
    const nextRun = this.queuedRuns.shift();
    if (nextRun === undefined) {
      throw new Error("No scripted runtime run available.");
    }

    return structuredClone(nextRun);
  }

  async listRunEvents(): Promise<RunEventRecord[]> {
    return structuredClone(this.queuedEvents.shift() ?? []);
  }
}

class FakePlanningBackend extends PlanningBackend<PlanningLocalFilesProviderConfig> {
  workItem: WorkItemRecord;
  readonly claimCalls: ClaimWorkItemInput[] = [];
  readonly markRunningCalls: MarkWorkItemRunningInput[] = [];
  readonly renewLeaseCalls: RenewLeaseInput[] = [];
  readonly transitionCalls: TransitionWorkItemInput[] = [];
  readonly comments: AppendCommentInput[] = [];
  readonly operationLog: string[] = [];
  private readonly failAppendComment: Error | null;

  constructor(
    workItem: WorkItemRecord,
    options: {
      failAppendComment?: Error;
    } = {},
  ) {
    super({
      name: "planning_test",
      kind: "planning.local_files",
      family: "planning",
      root: REPO_ROOT,
    });
    this.workItem = structuredClone(workItem);
    this.failAppendComment = options.failAppendComment ?? null;
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

  async claimWorkItem(input: ClaimWorkItemInput): Promise<WorkItemRecord> {
    this.operationLog.push("claim_work_item");
    this.claimCalls.push(structuredClone(input));
    this.workItem = {
      ...this.workItem,
      orchestration: {
        ...this.workItem.orchestration,
        state: "claimed",
        owner: input.owner,
        runId: input.runId,
        leaseUntil: input.leaseUntil,
        blockedReason: null,
        lastError: null,
        attemptCount: this.workItem.orchestration.attemptCount + 1,
      },
    };
    return structuredClone(this.workItem);
  }

  async markWorkItemRunning(
    input: MarkWorkItemRunningInput,
  ): Promise<WorkItemRecord> {
    this.operationLog.push("mark_work_item_running");
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
    this.operationLog.push("renew_lease");
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

  async transitionWorkItem(
    input: TransitionWorkItemInput,
  ): Promise<WorkItemRecord> {
    this.operationLog.push("transition_work_item");
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
        reviewOutcome: input.reviewOutcome ?? "none",
        blockedReason: input.blockedReason ?? null,
        lastError: input.lastError ?? null,
      },
    };
    return structuredClone(this.workItem);
  }

  async appendComment(input: AppendCommentInput): Promise<void> {
    this.operationLog.push("append_comment");
    this.comments.push(structuredClone(input));

    if (this.failAppendComment !== null) {
      throw this.failAppendComment;
    }
  }

  async buildDeepLink(): Promise<string | null> {
    return this.workItem.url ?? null;
  }
}

class FakeContextBackend extends ContextBackend<ContextLocalFilesProviderConfig> {
  readonly ensureCalls: EnsureArtifactInput[] = [];
  readonly loadCalls: LoadContextBundleInput[] = [];
  readonly createRunLedgerCalls: CreateRunLedgerEntryInput[] = [];
  readonly writePhaseArtifactCalls: WritePhaseArtifactInput[] = [];
  readonly finalizeRunLedgerCalls: FinalizeRunLedgerEntryInput[] = [];
  readonly appendEvidenceCalls: AppendEvidenceInput[] = [];
  readonly operationLog: string[] = [];

  constructor(private readonly artifact: ArtifactRecord) {
    super({
      name: "context_test",
      kind: "context.local_files",
      family: "context",
      root: REPO_ROOT,
      templates: {},
    });
  }

  async validateConfig(): Promise<void> {}

  async healthCheck(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async ensureArtifact(input: EnsureArtifactInput): Promise<ArtifactRecord> {
    this.operationLog.push("ensure_artifact");
    this.ensureCalls.push(structuredClone(input));
    return structuredClone(this.artifact);
  }

  async getArtifactByWorkItemId(
    workItemId: string,
  ): Promise<ArtifactRecord | null> {
    return workItemId === this.artifact.workItemId
      ? structuredClone(this.artifact)
      : null;
  }

  async loadContextBundle(input: LoadContextBundleInput): Promise<ContextBundle> {
    this.operationLog.push("load_context");
    this.loadCalls.push(structuredClone(input));
    return {
      artifact: structuredClone(this.artifact),
      contextText: "Loaded issue context.",
      references: [],
    };
  }

  async writePhaseArtifact(
    input: WritePhaseArtifactInput,
  ): Promise<ArtifactRecord> {
    this.operationLog.push("write_phase_artifact");
    this.writePhaseArtifactCalls.push(structuredClone(input));
    return {
      ...this.artifact,
      phase: input.phase,
      summary: input.summary ?? this.artifact.summary ?? null,
      implementationNotesPresent:
        input.phase === "implement" ? true : this.artifact.implementationNotesPresent,
      updatedAt: "2026-04-15T00:05:00.000Z",
    };
  }

  async createRunLedgerEntry(
    input: CreateRunLedgerEntryInput,
  ): Promise<RunLedgerRecord> {
    this.operationLog.push("create_run_ledger");
    this.createRunLedgerCalls.push(structuredClone(input));
    return {
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
  }

  async getRunLedgerEntry(runId: string): Promise<RunLedgerRecord | null> {
    const created = this.createRunLedgerCalls.find((call) => call.runId === runId);

    if (!created) {
      return null;
    }

    const finalized = this.finalizeRunLedgerCalls.find((call) => call.runId === runId);

    return {
      runId,
      workItemId: this.artifact.workItemId,
      artifactId: this.artifact.artifactId,
      phase: created.phase,
      status: finalized?.status ?? created.status,
      summary: finalized?.summary ?? null,
      verification: finalized?.verification ?? null,
      error: finalized?.error ?? null,
      startedAt: "2026-04-15T00:00:00.000Z",
      endedAt: finalized ? "2026-04-15T00:05:00.000Z" : null,
      url: `/tmp/${runId}.json`,
      updatedAt: finalized ? "2026-04-15T00:05:00.000Z" : "2026-04-15T00:00:00.000Z",
    };
  }

  async finalizeRunLedgerEntry(
    input: FinalizeRunLedgerEntryInput,
  ): Promise<RunLedgerRecord> {
    this.operationLog.push("finalize_run_ledger");
    this.finalizeRunLedgerCalls.push(structuredClone(input));
    return {
      runId: input.runId,
      workItemId: this.artifact.workItemId,
      artifactId: this.artifact.artifactId,
      phase: "implement",
      status: input.status,
      summary: input.summary ?? null,
      verification: input.verification ?? null,
      error: input.error ?? null,
      startedAt: "2026-04-15T00:00:00.000Z",
      endedAt: "2026-04-15T00:05:00.000Z",
      url: `/tmp/${input.runId}.json`,
      updatedAt: "2026-04-15T00:05:00.000Z",
    };
  }

  async appendEvidence(input: AppendEvidenceInput): Promise<void> {
    this.operationLog.push("append_evidence");
    this.appendEvidenceCalls.push(structuredClone(input));
  }
}

function createNowSequence(values: string[]): () => Date {
  const queue = [...values];
  return () => new Date(queue.shift() ?? values.at(-1) ?? new Date().toISOString());
}

function createPreparedRun(
  workItem: WorkItemRecord,
  artifact: ArtifactRecord,
): PreparedOrchestrationRun {
  return {
    runId: "run-99",
    owner: "orchestrator:test",
    leaseUntil: "2026-04-15T00:01:00.000Z",
    leaseDurationMs: 60_000,
    phase: "implement",
    claimedWorkItem: structuredClone(workItem),
    artifact: structuredClone(artifact),
    context: {
      artifact: structuredClone(artifact),
      contextText: "Loaded issue context.",
      references: [],
    },
    runLedger: {
      runId: "run-99",
      workItemId: workItem.id,
      artifactId: artifact.artifactId,
      phase: "implement",
      status: "queued",
      summary: null,
      verification: null,
      error: null,
      startedAt: "2026-04-15T00:00:00.000Z",
      endedAt: null,
      url: "/tmp/run-99.json",
      updatedAt: "2026-04-15T00:00:00.000Z",
    },
    submission: {
      runId: "run-99",
      phase: "implement",
      workItem: {
        id: workItem.id,
        identifier: workItem.identifier ?? null,
        title: workItem.title,
        description: workItem.description ?? null,
        labels: workItem.labels,
        url: workItem.url ?? null,
      },
      artifact: {
        artifactId: artifact.artifactId,
        url: artifact.url ?? null,
        summary: artifact.summary ?? null,
      },
      provider: "codex",
      workspace: {
        repoRoot: REPO_ROOT,
        mode: "ephemeral_worktree",
        workingDirHint: path.join(REPO_ROOT, ".worktrees", "run-99"),
        baseRef: "main",
      },
      prompt: {
        contractId: "orqestrate/implement/v1",
        systemPrompt: "Follow the contract.",
        userPrompt: "Implement the run submission flow.",
        attachments: [],
        sources: [],
        digests: {
          system: "system-digest",
          user: "user-digest",
        },
      },
      limits: {
        maxWallTimeSec: 3600,
        idleTimeoutSec: 300,
        bootstrapTimeoutSec: 120,
      },
      requestedBy: "Kimball Hill",
    },
  };
}

function createRuntimeRun(input: {
  runId: string;
  workItemId: string;
  workItemIdentifier: string | null;
  phase: "implement";
  provider: "codex";
  status: RuntimeApiRun["status"];
  repoRoot: string;
  artifactUrl: string | null;
  lastEventSeq: number;
  waitingHumanReason?: string | null;
  outcome?: RuntimeApiRun["outcome"];
}): RuntimeApiRun {
  return {
    runId: input.runId,
    workItemId: input.workItemId,
    workItemIdentifier: input.workItemIdentifier,
    phase: input.phase,
    provider: input.provider,
    status: input.status,
    repoRoot: input.repoRoot,
    workspace: {
      mode: "ephemeral_worktree",
      workingDirHint: path.join(input.repoRoot, ".worktrees", input.runId),
      workingDir: null,
      allocationId: null,
      baseRef: "main",
      branchName: null,
    },
    artifactUrl: input.artifactUrl,
    requestedBy: "Kimball Hill",
    promptContractId: "orqestrate/implement/v1",
    promptDigests: {
      system: "system-digest",
      user: "user-digest",
    },
    limits: {
      maxWallTimeSec: 3600,
      idleTimeoutSec: 300,
      bootstrapTimeoutSec: 120,
    },
    outcome: input.outcome ?? null,
    priority: 100,
    runtimeOwner: "runtime-daemon",
    attemptCount: 1,
    waitingHumanReason: input.waitingHumanReason ?? null,
    createdAt: "2026-04-15T00:00:00.000Z",
    admittedAt: "2026-04-15T00:00:01.000Z",
    startedAt: "2026-04-15T00:00:02.000Z",
    readyAt: input.status === "queued" ? null : "2026-04-15T00:00:03.000Z",
    completedAt:
      input.status === "completed" ? "2026-04-15T00:05:00.000Z" : null,
    lastHeartbeatAt: "2026-04-15T00:04:00.000Z",
    version: 1,
    lastEventSeq: input.lastEventSeq,
  };
}

function createWorkItem(
  overrides: Partial<WorkItemRecord> = {},
): WorkItemRecord {
  return {
    id: overrides.id ?? "ORQ-38",
    identifier: overrides.identifier ?? "ORQ-38",
    title: overrides.title ?? "Implement run submission flow",
    description:
      overrides.description ??
      "Submit runs to runtime and write outcomes back into planning/context.",
    status: overrides.status ?? "implement",
    phase: overrides.phase ?? "implement",
    priority: overrides.priority ?? 1,
    labels: overrides.labels ?? ["runtime"],
    url: overrides.url ?? "https://linear.app/orqestrate/issue/ORQ-38",
    parentId: overrides.parentId ?? null,
    dependencyIds: overrides.dependencyIds ?? [],
    blockedByIds: overrides.blockedByIds ?? [],
    blocksIds: overrides.blocksIds ?? [],
    artifactUrl: overrides.artifactUrl ?? "https://www.notion.so/orq-38",
    updatedAt: overrides.updatedAt ?? "2026-04-15T00:00:00.000Z",
    createdAt: overrides.createdAt ?? "2026-04-14T00:00:00.000Z",
    orchestration: overrides.orchestration ?? {
      state: "queued",
      owner: null,
      runId: null,
      leaseUntil: null,
      reviewOutcome: "none",
      blockedReason: null,
      lastError: null,
      attemptCount: 0,
    },
  };
}

function createArtifact(
  overrides: Partial<ArtifactRecord> = {},
): ArtifactRecord {
  return {
    artifactId: overrides.artifactId ?? "artifact-38",
    workItemId: overrides.workItemId ?? "ORQ-38",
    title: overrides.title ?? "ORQ-38 Artifact",
    phase: overrides.phase ?? "implement",
    state: overrides.state ?? "ready",
    url: overrides.url ?? "https://www.notion.so/orq-38",
    summary: overrides.summary ?? "Implementation artifact exists.",
    designReady: overrides.designReady ?? true,
    planReady: overrides.planReady ?? true,
    implementationNotesPresent: overrides.implementationNotesPresent ?? false,
    reviewSummaryPresent: overrides.reviewSummaryPresent ?? false,
    verificationEvidencePresent: overrides.verificationEvidencePresent ?? false,
    updatedAt: overrides.updatedAt ?? "2026-04-15T00:00:00.000Z",
    createdAt: overrides.createdAt ?? "2026-04-14T00:00:00.000Z",
  };
}
