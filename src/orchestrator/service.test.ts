import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ContextLocalFilesProviderConfig,
  ContextProviderConfig,
  LoadedConfig,
  PlanningProviderConfig,
} from "../config/types.js";
import type {
  AppendEvidenceInput,
  ContextBundle,
  CreateRunLedgerEntryInput,
  EnsureArtifactInput,
  FinalizeRunLedgerEntryInput,
  LoadContextBundleInput,
  WritePhaseArtifactInput,
} from "../core/context-backend.js";
import { ContextBackend } from "../core/context-backend.js";
import type {
  AppendCommentInput,
  ClaimWorkItemInput,
  ListActionableWorkItemsInput,
  MarkWorkItemRunningInput,
  RenewLeaseInput,
  TransitionWorkItemInput,
} from "../core/planning-backend.js";
import { PlanningBackend } from "../core/planning-backend.js";
import type {
  ArtifactRecord,
  RunLedgerRecord,
  WorkItemRecord,
} from "../domain-model.js";

import { openWakeupDatabase } from "./wakeup-database.js";
import { startOrchestratorService } from "./service.js";

test("orchestrator service runs an immediate actionable sweep for planning.linear", async (t) => {
  const fixture = createFixture(t);
  const loadedConfig = createLoadedConfigFixture("planning.linear");
  const planning = new FakePlanningBackend("planning.linear", [createWorkItem("issue-1")]);
  const context = new FakeContextBackend();
  const database = openWakeupDatabase(fixture.databasePath);
  const executeCalls: string[] = [];
  t.after(() => database.close());

  const service = await startOrchestratorService(
    loadedConfig,
    {
      repoRoot: fixture.repoRoot,
      actionableSweepIntervalMs: 60_000,
      wakeupIntervalMs: 60_000,
      now: () => new Date("2026-04-15T20:00:00.000Z"),
    },
    {
      planning,
      context,
      wakeupDatabase: database,
      executeClaimedRunFn: async (_dependencies, input) => {
        executeCalls.push(`${input.workItemId}:${input.requestedBy ?? ""}`);
        return {
          ok: false,
          workItem: createWorkItem(input.workItemId),
          resolution: {
            actionable: false,
            reason: "status_not_actionable",
            message: `Work item '${input.workItemId}' is already claimed.`,
            phase: "implement",
          },
        };
      },
    },
  );
  t.after(async () => {
    await service.stop();
  });

  assert.ok(service.actionableSweepLoop);
  assert.equal(service.actionableSweepLoop?.isRunning, true);
  assert.deepEqual(planning.listInputs, [{ limit: 10 }]);
  assert.equal(executeCalls.length, 1);
  assert.match(executeCalls[0] ?? "", /^issue-1:orchestrator:wakeup:sweep:/);
  assert.equal(service.wakeupRepository.list("queued").length, 0);
  assert.equal(service.wakeupRepository.list("done").length, 1);
});

test("orchestrator service leaves the actionable sweep disabled for non-linear planning providers", async (t) => {
  const fixture = createFixture(t);
  const loadedConfig = createLoadedConfigFixture("planning.local_files");
  const planning = new FakePlanningBackend("planning.local_files", [createWorkItem("issue-1")]);
  const context = new FakeContextBackend();
  const database = openWakeupDatabase(fixture.databasePath);
  let executeCalls = 0;
  t.after(() => database.close());

  const service = await startOrchestratorService(
    loadedConfig,
    {
      repoRoot: fixture.repoRoot,
      actionableSweepIntervalMs: 60_000,
      wakeupIntervalMs: 60_000,
      now: () => new Date("2026-04-15T20:00:00.000Z"),
    },
    {
      planning,
      context,
      wakeupDatabase: database,
      executeClaimedRunFn: async () => {
        executeCalls += 1;
        throw new Error("The non-linear service should not execute queued sweep work.");
      },
    },
  );
  t.after(async () => {
    await service.stop();
  });

  assert.equal(service.actionableSweepLoop, null);
  assert.deepEqual(planning.listInputs, []);
  assert.equal(executeCalls, 0);
  assert.equal(service.wakeupRepository.list().length, 0);
});

test("service stop waits for an in-flight actionable sweep before closing the wakeup database", async (t) => {
  const fixture = createFixture(t);
  const loadedConfig = createLoadedConfigFixture("planning.linear");
  const secondSweepStarted = createDeferred<void>();
  const releaseSecondSweep = createDeferred<WorkItemRecord[]>();
  let listCalls = 0;
  const planning = new FakePlanningBackend("planning.linear", [], {
    listActionableWorkItems: async (input) => {
      planning.listInputs.push(input);
      listCalls += 1;

      if (listCalls === 1) {
        return [];
      }

      secondSweepStarted.resolve();
      return releaseSecondSweep.promise;
    },
  });
  const context = new FakeContextBackend();
  const database = openWakeupDatabase(fixture.databasePath);
  t.after(() => database.close());

  const service = await startOrchestratorService(
    loadedConfig,
    {
      repoRoot: fixture.repoRoot,
      actionableSweepIntervalMs: 5,
      wakeupIntervalMs: 60_000,
      now: () => new Date("2026-04-15T20:00:00.000Z"),
    },
    {
      planning,
      context,
      wakeupDatabase: database,
      executeClaimedRunFn: async () => {
        throw new Error("No sweep-created wakeup should execute in this test.");
      },
    },
  );

  await secondSweepStarted.promise;
  const stopPromise = service.stop();
  releaseSecondSweep.resolve([]);
  await stopPromise;

  assert.ok(listCalls >= 2);
});

function createFixture(t: { after(callback: () => void): void }) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "orq-service-"));
  t.after(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  return {
    repoRoot: rootDir,
    databasePath: path.join(rootDir, "orchestrator.sqlite"),
  };
}

class FakePlanningBackend extends PlanningBackend<PlanningProviderConfig> {
  readonly listInputs: ListActionableWorkItemsInput[] = [];

  constructor(
    kind: PlanningProviderConfig["kind"],
    private readonly actionable: WorkItemRecord[],
    private readonly overrides: {
      listActionableWorkItems?: (
        input: ListActionableWorkItemsInput,
      ) => Promise<WorkItemRecord[]>;
    } = {},
  ) {
    super(
      kind === "planning.linear"
        ? {
            name: "planning",
            family: "planning",
            kind,
            tokenEnv: "LINEAR_TOKEN",
            team: "Orqestrate",
            mapping: {},
          }
        : {
            name: "planning",
            family: "planning",
            kind,
            root: "/tmp/planning",
          },
    );
  }

  async validateConfig(): Promise<void> {}

  async listActionableWorkItems(
    input: ListActionableWorkItemsInput,
  ): Promise<WorkItemRecord[]> {
    if (this.overrides.listActionableWorkItems !== undefined) {
      return this.overrides.listActionableWorkItems(input);
    }

    this.listInputs.push(input);
    return this.actionable.slice(0, input.limit);
  }

  async getWorkItem(): Promise<WorkItemRecord | null> {
    throw new Error("Not implemented in test.");
  }

  async claimWorkItem(_input: ClaimWorkItemInput): Promise<WorkItemRecord> {
    throw new Error("Not implemented in test.");
  }

  async markWorkItemRunning(
    _input: MarkWorkItemRunningInput,
  ): Promise<WorkItemRecord> {
    throw new Error("Not implemented in test.");
  }

  async renewLease(_input: RenewLeaseInput): Promise<WorkItemRecord> {
    throw new Error("Not implemented in test.");
  }

  async transitionWorkItem(
    _input: TransitionWorkItemInput,
  ): Promise<WorkItemRecord> {
    throw new Error("Not implemented in test.");
  }

  async appendComment(_input: AppendCommentInput): Promise<void> {
    throw new Error("Not implemented in test.");
  }

  async buildDeepLink(): Promise<string | null> {
    return null;
  }
}

class FakeContextBackend extends ContextBackend<ContextProviderConfig> {
  constructor() {
    super({
      name: "context",
      family: "context",
      kind: "context.local_files",
      root: "/tmp/context",
      templates: {},
    });
  }

  async validateConfig(): Promise<void> {}

  async ensureArtifact(_input: EnsureArtifactInput): Promise<ArtifactRecord> {
    throw new Error("Not implemented in test.");
  }

  async getArtifactByWorkItemId(): Promise<ArtifactRecord | null> {
    return null;
  }

  async loadContextBundle(
    _input: LoadContextBundleInput,
  ): Promise<ContextBundle> {
    throw new Error("Not implemented in test.");
  }

  async writePhaseArtifact(
    _input: WritePhaseArtifactInput,
  ): Promise<ArtifactRecord> {
    throw new Error("Not implemented in test.");
  }

  async createRunLedgerEntry(
    _input: CreateRunLedgerEntryInput,
  ): Promise<RunLedgerRecord> {
    throw new Error("Not implemented in test.");
  }

  async getRunLedgerEntry(): Promise<RunLedgerRecord | null> {
    return null;
  }

  async finalizeRunLedgerEntry(
    _input: FinalizeRunLedgerEntryInput,
  ): Promise<RunLedgerRecord> {
    throw new Error("Not implemented in test.");
  }

  async appendEvidence(_input: AppendEvidenceInput): Promise<void> {
    throw new Error("Not implemented in test.");
  }
}

function createLoadedConfigFixture(kind: PlanningProviderConfig["kind"]): LoadedConfig {
  const planningProvider: PlanningProviderConfig =
    kind === "planning.linear"
      ? {
          name: "planning",
          family: "planning",
          kind,
          tokenEnv: "LINEAR_TOKEN",
          team: "Orqestrate",
          mapping: {},
        }
      : {
          name: "planning",
          family: "planning",
          kind,
          root: "/tmp/planning",
        };
  const contextProvider: ContextLocalFilesProviderConfig = {
    name: "context",
    family: "context",
    kind: "context.local_files",
    root: "/tmp/context",
    templates: {},
  };

  return {
    sourcePath: "/tmp/config.toml",
    version: 1,
    env: {},
    paths: {
      stateDir: "/tmp/state",
      dataDir: "/tmp/data",
      logDir: "/tmp/logs",
    },
    workspace: {},
    policy: {
      maxConcurrentRuns: 1,
      maxRunsPerProvider: 1,
      allowMixedProviders: true,
      defaultPhaseTimeoutSec: 60,
      merge: {
        allowedMethods: ["squash"],
        requireHumanApproval: false,
      },
    },
    prompts: {
      root: "/tmp/prompts",
      activePack: "default",
      invariants: [],
    },
    promptCapabilities: {},
    promptPacks: {},
    providers: {},
    profiles: {},
    activeProfileName: "test",
    activeProfile: {
      name: "test",
      planningProviderName: "planning",
      contextProviderName: "context",
      promptPackName: "default",
      planningProvider,
      contextProvider,
      promptPack: {
        name: "default",
        baseSystem: "/tmp/system.md",
        roles: {},
        phases: {},
        capabilities: {},
        overlays: {
          organization: {},
          project: {},
        },
        experiments: {},
      },
      promptBehavior: {
        promptPackName: "default",
        promptPack: {
          name: "default",
          baseSystem: "/tmp/system.md",
          roles: {},
          phases: {},
          capabilities: {},
          overlays: {
            organization: {},
            project: {},
          },
          experiments: {},
        },
        organizationOverlayNames: [],
        projectOverlayNames: [],
        organizationOverlays: [],
        projectOverlays: [],
      },
    },
  };
}

function createWorkItem(id: string): WorkItemRecord {
  return {
    id,
    identifier: id.toUpperCase(),
    title: `Work item ${id}`,
    description: null,
    status: "implement",
    phase: "implement",
    priority: 1,
    labels: [],
    url: `https://linear.app/orqestrate/issue/${id}`,
    parentId: null,
    dependencyIds: [],
    blockedByIds: [],
    blocksIds: [],
    artifactUrl: null,
    updatedAt: "2026-04-15T00:00:00.000Z",
    createdAt: "2026-04-15T00:00:00.000Z",
    orchestration: {
      state: "queued",
      owner: null,
      runId: null,
      leaseUntil: null,
      reviewOutcome: null,
      blockedReason: null,
      lastError: null,
      attemptCount: 0,
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}
