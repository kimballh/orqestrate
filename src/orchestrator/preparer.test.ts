import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { LoadedConfig, PlanningLocalFilesProviderConfig, ContextLocalFilesProviderConfig } from "../config/types.js";
import { loadConfig } from "../config/loader.js";
import type {
  ArtifactRecord,
  RunLedgerRecord,
  WorkItemRecord,
} from "../domain-model.js";
import {
  ContextBackend,
  type ContextBundle,
  type CreateRunLedgerEntryInput,
  type EnsureArtifactInput,
  type FinalizeRunLedgerEntryInput,
  type LoadContextBundleInput,
  type WritePhaseArtifactInput,
  type AppendEvidenceInput,
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

import { prepareClaimedRun } from "./preparer.js";
import { HumanBlockerError } from "./transition-policy.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("returns a prepared run after claiming, loading context, and assembling the prompt", async () => {
  const config = await loadLocalConfig();
  const workItem = createWorkItem();
  const artifact = createArtifact();
  const planning = new FakePlanningBackend(workItem);
  const context = new FakeContextBackend(artifact);

  const result = await prepareClaimedRun(
    { planning, context, config },
    {
      workItemId: workItem.id,
      provider: "codex",
      repoRoot: REPO_ROOT,
      owner: "orchestrator:test",
      requestedBy: "Kimball Hill",
      createRunId: () => "run-37",
      now: new Date("2026-04-15T00:00:00.000Z"),
      prompt: {
        operatorNote: "Keep the run narrow.",
      },
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("Expected a prepared run result.");
  }

  assert.equal(planning.claimCalls.length, 1);
  assert.equal(planning.claimCalls[0]?.phase, "implement");
  assert.equal(context.ensureCalls.length, 1);
  assert.equal(context.loadCalls.length, 1);
  assert.equal(result.prepared.runId, "run-37");
  assert.equal(result.prepared.owner, "orchestrator:test");
  assert.equal(
    result.prepared.submission.workspace.workingDirHint,
    path.join(REPO_ROOT, ".worktrees", "run-37"),
  );
  assert.equal(result.prepared.submission.limits.maxWallTimeSec, config.policy.defaultPhaseTimeoutSec);
  assert.match(result.prepared.submission.prompt.userPrompt, /Keep the run narrow\./);
  assert.match(result.prepared.submission.prompt.userPrompt, /Loaded issue context\./);
});

test("returns a non-prepared result when the work item is not currently claimable", async () => {
  const config = await loadLocalConfig();
  const workItem = createWorkItem({
    orchestration: {
      state: "waiting_human",
      owner: null,
      runId: null,
      leaseUntil: null,
      reviewOutcome: "none",
      blockedReason: "Need signoff",
      lastError: null,
      attemptCount: 1,
    },
  });
  const planning = new FakePlanningBackend(workItem);
  const context = new FakeContextBackend(createArtifact());

  const result = await prepareClaimedRun(
    { planning, context, config },
    {
      workItemId: workItem.id,
      provider: "codex",
      repoRoot: REPO_ROOT,
      owner: "orchestrator:test",
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("Expected a non-claimable result.");
  }

  assert.ok(result.decision);
  assert.equal(result.decision.claimable, false);
  assert.equal(result.decision.reason, "waiting_human");
  assert.equal(planning.claimCalls.length, 0);
  assert.equal(context.ensureCalls.length, 0);
});

test("transitions the ticket to failed when post-claim context loading errors", async () => {
  const config = await loadLocalConfig();
  const planning = new FakePlanningBackend(createWorkItem());
  const context = new FakeContextBackend(createArtifact(), {
    failLoadContext: new Error("context backend unavailable"),
  });

  await assert.rejects(
    () =>
      prepareClaimedRun(
        { planning, context, config },
        {
          workItemId: "ORQ-37",
          provider: "codex",
          repoRoot: REPO_ROOT,
          owner: "orchestrator:test",
          createRunId: () => "run-38",
          now: new Date("2026-04-15T00:00:00.000Z"),
        },
      ),
    /context backend unavailable/,
  );

  assert.equal(planning.transitionCalls.length, 1);
  assert.equal(planning.transitionCalls[0]?.state, "failed");
  assert.equal(planning.transitionCalls[0]?.nextStatus, "implement");
  assert.equal(planning.transitionCalls[0]?.lastError?.providerFamily, "context");
});

test("transitions the ticket to blocked when post-claim work surfaces a human blocker", async () => {
  const config = await loadLocalConfig();
  const planning = new FakePlanningBackend(createWorkItem());
  const context = new FakeContextBackend(createArtifact(), {
    failLoadContext: new HumanBlockerError("Need design signoff"),
  });

  await assert.rejects(
    () =>
      prepareClaimedRun(
        { planning, context, config },
        {
          workItemId: "ORQ-37",
          provider: "codex",
          repoRoot: REPO_ROOT,
          owner: "orchestrator:test",
          createRunId: () => "run-39",
          now: new Date("2026-04-15T00:00:00.000Z"),
        },
      ),
    /Need design signoff/,
  );

  assert.equal(planning.transitionCalls.length, 1);
  assert.equal(planning.transitionCalls[0]?.nextStatus, "blocked");
  assert.equal(planning.transitionCalls[0]?.state, "waiting_human");
  assert.equal(planning.transitionCalls[0]?.blockedReason, "Need design signoff");
});

async function loadLocalConfig(): Promise<LoadedConfig> {
  return loadConfig({
    configPath: path.join(REPO_ROOT, "docs/config.example.toml"),
    cwd: REPO_ROOT,
  });
}

class FakePlanningBackend extends PlanningBackend<PlanningLocalFilesProviderConfig> {
  workItem: WorkItemRecord;
  readonly claimCalls: ClaimWorkItemInput[] = [];
  readonly transitionCalls: TransitionWorkItemInput[] = [];

  constructor(workItem: WorkItemRecord) {
    super({
      name: "planning_test",
      kind: "planning.local_files",
      family: "planning",
      root: REPO_ROOT,
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

  async claimWorkItem(input: ClaimWorkItemInput): Promise<WorkItemRecord> {
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
    _input: MarkWorkItemRunningInput,
  ): Promise<WorkItemRecord> {
    throw new Error("not used in test");
  }

  async renewLease(_input: RenewLeaseInput): Promise<WorkItemRecord> {
    throw new Error("not used in test");
  }

  async transitionWorkItem(
    input: TransitionWorkItemInput,
  ): Promise<WorkItemRecord> {
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

  async buildDeepLink(_id: string): Promise<string | null> {
    return this.workItem.url ?? null;
  }
}

class FakeContextBackend extends ContextBackend<ContextLocalFilesProviderConfig> {
  readonly ensureCalls: EnsureArtifactInput[] = [];
  readonly loadCalls: LoadContextBundleInput[] = [];

  constructor(
    private readonly artifact: ArtifactRecord,
    private readonly options: {
      failLoadContext?: Error;
    } = {},
  ) {
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
    this.ensureCalls.push(structuredClone(input));
    return structuredClone(this.artifact);
  }

  async getArtifactByWorkItemId(
    workItemId: string,
  ): Promise<ArtifactRecord | null> {
    return workItemId === this.artifact.workItemId ? structuredClone(this.artifact) : null;
  }

  async loadContextBundle(input: LoadContextBundleInput): Promise<ContextBundle> {
    this.loadCalls.push(structuredClone(input));

    if (this.options.failLoadContext) {
      throw this.options.failLoadContext;
    }

    return {
      artifact: structuredClone(this.artifact),
      contextText: "Loaded issue context.",
      references: [
        {
          kind: "notion",
          title: "Artifact",
          url: this.artifact.url ?? null,
        },
      ],
    };
  }

  async writePhaseArtifact(
    _input: WritePhaseArtifactInput,
  ): Promise<ArtifactRecord> {
    throw new Error("not used in test");
  }

  async createRunLedgerEntry(
    _input: CreateRunLedgerEntryInput,
  ): Promise<RunLedgerRecord> {
    throw new Error("not used in test");
  }

  async finalizeRunLedgerEntry(
    _input: FinalizeRunLedgerEntryInput,
  ): Promise<RunLedgerRecord> {
    throw new Error("not used in test");
  }

  async appendEvidence(_input: AppendEvidenceInput): Promise<void> {
    throw new Error("not used in test");
  }
}

function createWorkItem(
  overrides: Partial<WorkItemRecord> = {},
): WorkItemRecord {
  return {
    id: overrides.id ?? "ORQ-37",
    identifier: overrides.identifier ?? "ORQ-37",
    title: overrides.title ?? "Implement orchestrator core",
    description: overrides.description ?? "Claim and prepare work safely.",
    status: overrides.status ?? "implement",
    phase: overrides.phase ?? "implement",
    priority: overrides.priority ?? 1,
    labels: overrides.labels ?? ["orchestration"],
    url: overrides.url ?? "https://linear.app/orqestrate/issue/ORQ-37",
    parentId: overrides.parentId ?? null,
    dependencyIds: overrides.dependencyIds ?? [],
    blockedByIds: overrides.blockedByIds ?? [],
    blocksIds: overrides.blocksIds ?? [],
    artifactUrl: overrides.artifactUrl ?? "https://www.notion.so/orq-37",
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
    artifactId: overrides.artifactId ?? "artifact-37",
    workItemId: overrides.workItemId ?? "ORQ-37",
    title: overrides.title ?? "ORQ-37 Artifact",
    phase: overrides.phase ?? "implement",
    state: overrides.state ?? "ready",
    url: overrides.url ?? "https://www.notion.so/orq-37",
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
