import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import type { GitHubCliClient } from "../github/client.js";

import { prepareClaimedRun } from "./preparer.js";
import type { RuntimeObserver } from "./runtime-observer.js";
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
  assert.equal(context.createRunLedgerCalls.length, 1);
  assert.equal(context.finalizeRunLedgerCalls.length, 0);
  assert.equal(result.prepared.runId, "run-37");
  assert.equal(result.prepared.owner, "orchestrator:test");
  assert.equal(result.prepared.runLedger.runId, "run-37");
  assert.equal(result.prepared.runLedger.status, "queued");
  assert.equal(
    result.prepared.submission.workspace.workingDirHint,
    path.join(REPO_ROOT, ".worktrees", "run-37"),
  );
  assert.equal(result.prepared.submission.limits.maxWallTimeSec, config.policy.defaultPhaseTimeoutSec);
  assert.match(result.prepared.submission.prompt.userPrompt, /Keep the run narrow\./);
  assert.match(result.prepared.submission.prompt.userPrompt, /Loaded issue context\./);
  assert.equal(
    result.prepared.submission.promptProvenance?.selection.promptPackName,
    "default",
  );
  assert.deepEqual(
    result.prepared.submission.promptProvenance?.rendered.attachmentKinds,
    ["planning_url", "artifact_url"],
  );
  assert.equal(result.prepared.submission.promptReplayContext?.runId, "run-37");
  assert.equal(
    result.prepared.submission.promptReplayContext?.workspace.assignedBranch,
    null,
  );
  assert.match(
    result.prepared.submission.promptReplayContext?.additionalContext ?? "",
    /Loaded issue context\./,
  );
  assert.ok(
    result.prepared.submission.promptProvenance?.sources.some(
      (source) => source.ref === "run-context",
    ),
  );
});

test("includes configured workspace setup metadata in the prepared submission", async () => {
  const config = await loadLocalConfig();
  const repoRoot = createFixtureRepoRoot();
  const scriptPath = path.join(repoRoot, "scripts", "prepare-worktree.sh");
  mkdirSync(path.dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  const workItem = createWorkItem();
  const artifact = createArtifact();
  const planning = new FakePlanningBackend(workItem);
  const context = new FakeContextBackend(artifact);

  const result = await prepareClaimedRun(
    {
      planning,
      context,
      config: {
        ...config,
        workspace: {
          setupScript: scriptPath,
        },
      },
    },
    {
      workItemId: workItem.id,
      provider: "codex",
      repoRoot,
      owner: "orchestrator:test",
      createRunId: () => "run-setup",
      now: new Date("2026-04-15T00:00:00.000Z"),
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("Expected a prepared run result.");
  }

  assert.deepEqual(result.prepared.submission.workspace.setup, {
    source: "config",
    scriptPath,
  });
  assert.deepEqual(result.prepared.submission.promptReplayContext?.workspace.setup, {
    source: "config",
    scriptPath,
  });
  assert.match(
    result.prepared.submission.prompt.userPrompt,
    /Workspace setup source: config/,
  );
  assert.match(
    result.prepared.submission.prompt.userPrompt,
    new RegExp(scriptPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
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

test("rehydrates PR workspace context from runtime history and injects review-loop context", async () => {
  const config = await loadLocalConfig();
  const workItem = createWorkItem({
    status: "review",
    phase: "review",
  });
  const artifact = createArtifact();
  const planning = new FakePlanningBackend(workItem);
  const context = new FakeContextBackend(artifact);
  const runtimeObserver = new FakeRuntimeObserver([
    {
      runId: "run-previous",
      workItemId: workItem.id,
      workItemIdentifier: workItem.identifier ?? null,
      phase: "implement",
      provider: "codex",
      status: "completed",
      repoRoot: REPO_ROOT,
      workspace: {
        mode: "ephemeral_worktree",
        assignedBranch: "hillkimball/orq-43",
        pullRequestUrl: null,
        pullRequestMode: "draft",
        writeScope: "repo",
      },
      artifactUrl: artifact.url ?? null,
      requestedBy: "Kimball Hill",
      grantedCapabilities: ["github.read_pr"],
      promptContractId: "orqestrate/default/review/review/v2",
      promptDigests: { system: null, user: "digest" },
      limits: {
        maxWallTimeSec: 3600,
        idleTimeoutSec: 300,
        bootstrapTimeoutSec: 120,
      },
      outcome: null,
      createdAt: "2026-04-15T00:00:00.000Z",
      admittedAt: "2026-04-15T00:00:01.000Z",
      startedAt: "2026-04-15T00:00:02.000Z",
      readyAt: "2026-04-15T00:00:03.000Z",
      completedAt: "2026-04-15T00:10:00.000Z",
      lastHeartbeatAt: "2026-04-15T00:05:00.000Z",
      lastEventSeq: 5,
      priority: 100,
      runtimeOwner: "runtime-daemon:test",
      attemptCount: 1,
      waitingHumanReason: null,
      version: 1,
    }],
  );
  const githubClient: Pick<
    GitHubCliClient,
    "readPullRequest" | "findOpenPullRequestForBranch"
  > = {
    findOpenPullRequestForBranch: async () => ({
      number: 43,
      title: "Implement ORQ-43",
      url: "https://github.com/kimballh/orqestrate/pull/43",
      body: "Body",
      headRefName: "hillkimball/orq-43",
      baseRefName: "main",
      authorLogin: "kimballh",
    }),
    readPullRequest: async () => ({
      viewerLogin: "kimballh",
      pullRequest: {
        id: "PR_kwDOORQ43",
        number: 43,
        title: "Implement ORQ-43",
        url: "https://github.com/kimballh/orqestrate/pull/43",
        state: "OPEN",
        isDraft: false,
        body: "Body",
        baseRefName: "main",
        headRefName: "hillkimball/orq-43",
        reviewDecision: "REVIEW_REQUIRED",
        authorLogin: "kimballh",
      },
      files: [],
      reviews: [],
      threads: [
        {
          id: "thread-1",
          isResolved: false,
          isOutdated: false,
          path: "src/orchestrator/reconciliation-loop.ts",
          line: 88,
          originalLine: 88,
          startLine: null,
          originalStartLine: null,
          diffSide: "RIGHT",
          comments: [
            {
              id: "comment-1",
              databaseId: 101,
              url: "https://github.com/comment/101",
              body: "Please move this back to implement when reviewer feedback lands.",
              authorLogin: "reviewer",
              createdAt: "2026-04-15T00:00:00.000Z",
            },
          ],
        },
      ],
    }),
  };

  const result = await prepareClaimedRun(
    {
      planning,
      context,
      config,
      runtimeObserver,
      createGitHubClient: () => githubClient,
      getOriginRemoteUrl: async () => "git@github.com:kimballh/orqestrate.git",
    },
    {
      workItemId: workItem.id,
      provider: "codex",
      repoRoot: REPO_ROOT,
      owner: "orchestrator:test",
      createRunId: () => "run-43",
      now: new Date("2026-04-15T00:00:00.000Z"),
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("Expected a prepared run result.");
  }

  assert.equal(
    result.prepared.submission.workspace.pullRequestUrl,
    "https://github.com/kimballh/orqestrate/pull/43",
  );
  assert.equal(
    result.prepared.submission.workspace.assignedBranch,
    "hillkimball/orq-43",
  );
  assert.deepEqual(result.prepared.reviewLoop?.implementerActionThreadIds, [
    "thread-1",
  ]);
  assert.match(
    result.prepared.submission.prompt.userPrompt,
    /Threads requiring review action: 0/,
  );
  assert.match(
    result.prepared.submission.prompt.userPrompt,
    /Threads requiring implementation action: 1/,
  );
  assert.deepEqual(result.prepared.submission.grantedCapabilities, [
    "github.read_pr",
  ]);
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
  assert.equal(context.createRunLedgerCalls.length, 0);
  assert.equal(context.finalizeRunLedgerCalls.length, 0);
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
  assert.equal(context.createRunLedgerCalls.length, 0);
  assert.equal(context.finalizeRunLedgerCalls.length, 0);
});

test("finalizes the queued run ledger if prompt assembly fails after the ledger is created", async () => {
  const config = await loadLocalConfig();
  const planning = new FakePlanningBackend(createWorkItem());
  const context = new FakeContextBackend(createArtifact());

  await assert.rejects(
    () =>
      prepareClaimedRun(
        { planning, context, config },
        {
          workItemId: "ORQ-37",
          provider: "codex",
          repoRoot: REPO_ROOT,
          owner: "orchestrator:test",
          createRunId: () => "run-40",
          now: new Date("2026-04-15T00:00:00.000Z"),
          prompt: {
            capabilities: ["missing_capability"],
          },
        },
      ),
    /Unknown prompt capabilities requested: missing_capability\./,
  );

  assert.equal(planning.transitionCalls.length, 1);
  assert.equal(planning.transitionCalls[0]?.state, "failed");
  assert.equal(context.createRunLedgerCalls.length, 1);
  assert.equal(context.finalizeRunLedgerCalls.length, 1);
  assert.equal(context.finalizeRunLedgerCalls[0]?.runId, "run-40");
  assert.equal(context.finalizeRunLedgerCalls[0]?.status, "failed");
  assert.match(context.finalizeRunLedgerCalls[0]?.summary ?? "", /assemble_prompt failed/);
});

test("finalizes the queued run ledger even if the planning transition throws", async () => {
  const config = await loadLocalConfig();
  const planning = new FakePlanningBackend(createWorkItem(), {
    failTransition: new Error("planning transition failed"),
  });
  const context = new FakeContextBackend(createArtifact());

  await assert.rejects(
    () =>
      prepareClaimedRun(
        { planning, context, config },
        {
          workItemId: "ORQ-37",
          provider: "codex",
          repoRoot: REPO_ROOT,
          owner: "orchestrator:test",
          createRunId: () => "run-41",
          now: new Date("2026-04-15T00:00:00.000Z"),
          prompt: {
            capabilities: ["missing_capability"],
          },
        },
      ),
    /planning transition failed/,
  );

  assert.equal(context.createRunLedgerCalls.length, 1);
  assert.equal(context.finalizeRunLedgerCalls.length, 1);
  assert.equal(context.finalizeRunLedgerCalls[0]?.runId, "run-41");
  assert.equal(context.finalizeRunLedgerCalls[0]?.status, "failed");
  assert.equal(planning.transitionCalls.length, 1);
});

test("blocks the run when Codex fallback metadata is malformed", async () => {
  const config = await loadLocalConfig();
  const repoRoot = createFixtureRepoRoot();
  writeFileSync(
    path.join(repoRoot, ".codex", "environments", "environment.toml"),
    `[setup]
script = 7
`,
    "utf8",
  );
  const planning = new FakePlanningBackend(createWorkItem());
  const context = new FakeContextBackend(createArtifact());

  await assert.rejects(
    () =>
      prepareClaimedRun(
        { planning, context, config },
        {
          workItemId: "ORQ-37",
          provider: "codex",
          repoRoot,
          owner: "orchestrator:test",
          createRunId: () => "run-bad-codex-env",
          now: new Date("2026-04-15T00:00:00.000Z"),
        },
      ),
    /Codex environment fallback/,
  );

  assert.equal(context.createRunLedgerCalls.length, 1);
  assert.equal(context.finalizeRunLedgerCalls.length, 1);
  assert.equal(planning.transitionCalls.length, 1);
  assert.equal(planning.transitionCalls[0]?.nextStatus, "blocked");
  assert.equal(planning.transitionCalls[0]?.state, "waiting_human");
});

async function loadLocalConfig(): Promise<LoadedConfig> {
  return loadConfig({
    configPath: path.join(REPO_ROOT, "config.example.toml"),
    cwd: REPO_ROOT,
  });
}

function createFixtureRepoRoot(): string {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "orqestrate-preparer-"));
  mkdirSync(path.join(repoRoot, ".codex", "environments"), { recursive: true });
  return repoRoot;
}

class FakePlanningBackend extends PlanningBackend<PlanningLocalFilesProviderConfig> {
  workItem: WorkItemRecord;
  readonly claimCalls: ClaimWorkItemInput[] = [];
  readonly transitionCalls: TransitionWorkItemInput[] = [];
  private readonly failTransition: Error | null;

  constructor(
    workItem: WorkItemRecord,
    options: { failTransition?: Error } = {},
  ) {
    super({
      name: "planning_test",
      kind: "planning.local_files",
      family: "planning",
      root: REPO_ROOT,
    });
    this.workItem = structuredClone(workItem);
    this.failTransition = options.failTransition ?? null;
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

    if (this.failTransition !== null) {
      throw this.failTransition;
    }

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
  readonly createRunLedgerCalls: CreateRunLedgerEntryInput[] = [];
  readonly finalizeRunLedgerCalls: FinalizeRunLedgerEntryInput[] = [];

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
    input: CreateRunLedgerEntryInput,
  ): Promise<RunLedgerRecord> {
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

    return {
      runId,
      workItemId: this.artifact.workItemId,
      artifactId: this.artifact.artifactId,
      phase: created.phase,
      status: created.status,
      summary: null,
      verification: null,
      error: null,
      startedAt: "2026-04-15T00:00:00.000Z",
      endedAt: null,
      url: `/tmp/${runId}.json`,
      updatedAt: "2026-04-15T00:00:00.000Z",
    };
  }

  async finalizeRunLedgerEntry(
    input: FinalizeRunLedgerEntryInput,
  ): Promise<RunLedgerRecord> {
    this.finalizeRunLedgerCalls.push(structuredClone(input));
    return {
      runId: input.runId,
      workItemId: this.artifact.workItemId,
      artifactId: this.artifact.artifactId,
      phase: "implement",
      status: input.status,
      summary: input.summary ?? null,
      verification: null,
      error: input.error ?? null,
      startedAt: "2026-04-15T00:00:00.000Z",
      endedAt: "2026-04-15T00:01:00.000Z",
      url: `/tmp/${input.runId}.json`,
      updatedAt: "2026-04-15T00:01:00.000Z",
    };
  }

  async appendEvidence(_input: AppendEvidenceInput): Promise<void> {
    throw new Error("not used in test");
  }
}

class FakeRuntimeObserver implements RuntimeObserver {
  constructor(private readonly runs: any[]) {}

  async getRun(): Promise<null> {
    return null;
  }

  async listRuns(): Promise<{ runs: any[]; nextCursor?: string | null }> {
    return {
      runs: structuredClone(this.runs),
      nextCursor: null,
    };
  }

  async listRunEvents(): Promise<[]> {
    return [];
  }

  async getHealth(): Promise<any> {
    return {
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
