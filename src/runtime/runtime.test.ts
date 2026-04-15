import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RuntimeConfig } from "./config.js";
import { RuntimeDaemon } from "./daemon.js";
import { startRuntimeDaemon, startRuntimeService } from "./main.js";
import { openRuntimeDatabase } from "./persistence/database.js";
import {
  getRuntimeSchemaVersion,
  RUNTIME_SCHEMA_VERSION,
} from "./persistence/migrations.js";
import { RuntimeRepository } from "./persistence/runtime-repository.js";
import { RuntimeAdapterRegistry } from "./runtime-adapter-registry.js";
import type { LaunchSpec, SessionObserver, SessionSnapshot, SessionSupervisor } from "./session-supervisor.js";
import type { CreateRunInput } from "./types.js";
import type { LoadedConfig } from "../config/types.js";
import { FakeProviderAdapter, waitForAsyncTurn } from "./test-support.js";
import type { RuntimeApiServer } from "./api/server.js";

type RuntimeFixture = {
  rootDir: string;
  runtimeConfig: RuntimeConfig;
};

test("openRuntimeDatabase initializes WAL mode and the canonical schema", (t) => {
  const fixture = createRuntimeFixture(t);
  const database = openRuntimeDatabase(fixture.runtimeConfig.databasePath);
  t.after(() => database.close());

  assert.equal(
    getRuntimeSchemaVersion(database.connection),
    RUNTIME_SCHEMA_VERSION,
  );
  assert.equal(
    database.connection.pragma("journal_mode", { simple: true }),
    "wal",
  );

  const tableNames = (
    database.connection
      .prepare(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name IN ('runs', 'run_events', 'session_heartbeats', 'workspace_allocations')
          ORDER BY name
        `,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);

  assert.deepEqual(tableNames, [
    "run_events",
    "runs",
    "session_heartbeats",
    "workspace_allocations",
  ]);
});

test("runtime daemon preserves queued runs across restart", async (t) => {
  const fixture = createRuntimeFixture(t);
  const daemon = new RuntimeDaemon(fixture.runtimeConfig, {
    adapterRegistry: new RuntimeAdapterRegistry(),
  });

  daemon.start();
  const createdRun = daemon.enqueueRun(createRunInput());
  assert.ok(existsSync(fixture.runtimeConfig.runtimeLogDir));

  await daemon.stop();

  const restartedDaemon = new RuntimeDaemon(fixture.runtimeConfig, {
    adapterRegistry: new RuntimeAdapterRegistry(),
  });
  restartedDaemon.start();
  t.after(async () => restartedDaemon.stop());

  const recoveredRun = restartedDaemon.getRun(createdRun.runId);
  assert.ok(recoveredRun);
  assert.equal(recoveredRun.status, "queued");
  assert.equal(recoveredRun.createdAt, createdRun.createdAt);
});

test("enqueueRun is idempotent and emits the initial queue event once", (t) => {
  const repository = createRepository(t);
  const createdRun = repository.enqueueRun(createRunInput());
  const duplicateRun = repository.enqueueRun(createRunInput());
  const events = repository.listRunEvents(createdRun.runId);

  assert.equal(createdRun.runId, duplicateRun.runId);
  assert.equal(createdRun.status, "queued");
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "run_enqueued");
  assert.deepEqual(events[0].payload, {
    phase: "implement",
    provider: "codex",
    status: "queued",
  });
});

test("listRuns supports the basic runtime filters", (t) => {
  const repository = createRepository(t);

  repository.enqueueRun(createRunInput());
  repository.enqueueRun(
    createRunInput({
      runId: "run-002",
      phase: "review",
      provider: "claude",
      workItem: {
        id: "issue-2",
        identifier: "ORQ-33",
      },
      workspace: {
        repoRoot: "/repo-two",
      },
    }),
  );
  repository.enqueueRun(
    createRunInput({
      runId: "run-003",
      workItem: {
        id: "issue-3",
        identifier: "ORQ-34",
      },
    }),
  );

  assert.equal(repository.listRuns({ status: "queued" }).length, 3);
  assert.equal(repository.listRuns({ provider: "claude" }).length, 1);
  assert.equal(repository.listRuns({ phase: "review" }).length, 1);
  assert.equal(repository.listRuns({ workItemId: "issue-3" }).length, 1);
  assert.equal(repository.listRuns({ repoRoot: "/repo-two" }).length, 1);
  assert.equal(repository.listRuns({ limit: 2 }).length, 2);
});

test("recordHeartbeat persists liveness evidence and updates the run snapshot", (t) => {
  const { database, repository } = createRepositoryFixture(t);
  const run = repository.enqueueRun(createRunInput());
  const emittedAt = "2026-04-14T07:15:00.000Z";

  const heartbeat = repository.recordHeartbeat({
    runId: run.runId,
    emittedAt,
    source: "supervisor_tick",
    bytesRead: 256,
    bytesWritten: 32,
    fileChanges: 1,
    providerState: "running",
    note: "first heartbeat",
  });

  const refreshedRun = repository.getRun(run.runId);
  const persistedCount = database.connection
    .prepare(
      "SELECT COUNT(*) AS count FROM session_heartbeats WHERE run_id = ?",
    )
    .get(run.runId) as { count: number };

  assert.equal(heartbeat.heartbeatId, 1);
  assert.equal(refreshedRun?.lastHeartbeatAt, emittedAt);
  assert.equal(persistedCount.count, 1);
});

test("recordHeartbeat does not regress the canonical liveness timestamp", (t) => {
  const repository = createRepository(t);
  const run = repository.enqueueRun(createRunInput());

  repository.recordHeartbeat({
    runId: run.runId,
    emittedAt: "2026-04-14T10:00:00.000Z",
    source: "supervisor_tick",
    bytesRead: 128,
    bytesWritten: 16,
    fileChanges: 0,
    providerState: "running",
    note: null,
  });
  repository.recordHeartbeat({
    runId: run.runId,
    emittedAt: "2026-04-14T09:00:00.000Z",
    source: "supervisor_tick",
    bytesRead: 64,
    bytesWritten: 8,
    fileChanges: 0,
    providerState: "running",
    note: "late arrival",
  });

  const refreshedRun = repository.getRun(run.runId);
  assert.equal(refreshedRun?.lastHeartbeatAt, "2026-04-14T10:00:00.000Z");
});

test("workspace allocations persist and support explicit state transitions", (t) => {
  const repository = createRepository(t);

  const createdAllocation = repository.createWorkspaceAllocation({
    workspaceAllocationId: "alloc-001",
    repoKey: "repo-key",
    repoRoot: "/repo",
    mode: "ephemeral_worktree",
    workingDir: "/repo/.worktrees/alloc-001",
    branchName: "hillkimball/orq-32-scaffold-runtime-daemon-package-sqlite-schema-and-run",
    baseRef: "main",
  });

  const updatedAllocation = repository.updateWorkspaceAllocationStatus({
    workspaceAllocationId: createdAllocation.workspaceAllocationId,
    status: "ready",
    readyAt: "2026-04-14T07:20:00.000Z",
    leaseUntil: "2026-04-14T07:40:00.000Z",
  });

  assert.equal(createdAllocation.status, "preparing");
  assert.equal(updatedAllocation.status, "ready");
  assert.equal(updatedAllocation.readyAt, "2026-04-14T07:20:00.000Z");
  assert.equal(updatedAllocation.leaseUntil, "2026-04-14T07:40:00.000Z");
});

test("runtime SQL migration asset is available to the source loader", () => {
  const migrationPath = new URL(
    "./persistence/sql/0001_initial.sql",
    import.meta.url,
  );

  const sql = readFileSync(migrationPath, "utf8");
  assert.match(sql, /CREATE TABLE runs/);
});

test("startRuntimeDaemon does not create a keepalive timer when startup fails", () => {
  let keepAliveCalls = 0;
  let registeredSignals = 0;

  assert.throws(
    () =>
      startRuntimeDaemon(createLoadedConfigFixture(), {
        createRuntimeDaemon: () =>
          ({
            runtimeConfig: { databasePath: "/tmp/runtime.sqlite" },
            start(): void {
              throw new Error("boom");
            },
            async stop(): Promise<void> {
              throw new Error("stop should not be called");
            },
          }) as RuntimeDaemon,
        setKeepAlive: (() => {
          keepAliveCalls += 1;
          return setInterval(() => undefined, 60_000);
        }) as typeof setInterval,
        registerSignalHandler: () => {
          registeredSignals += 1;
        },
      }),
    /boom/,
  );

  assert.equal(keepAliveCalls, 0);
  assert.equal(registeredSignals, 0);
});

test("startRuntimeService waits for daemon shutdown before exiting on signal", async (t) => {
  const fixture = createRuntimeFixture(t);
  const supervisor = new DelayedLaunchSessionSupervisor();
  const daemon = new RuntimeDaemon(fixture.runtimeConfig, {
    adapterRegistry: new RuntimeAdapterRegistry(),
    sessionSupervisor: supervisor,
    dispatcherIntervalMs: 5,
  });
  daemon.registerRuntimeAdapter("codex", () => new FakeProviderAdapter());

  const signalHandlers = new Map<"SIGINT" | "SIGTERM", () => void>();
  let exitCalls: number = 0;
  const apiServer = {
    info: {
      endpoint: "http://runtime.test",
      listening: true,
    },
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
  } as RuntimeApiServer;

  await startRuntimeService(createLoadedConfigFixture(), {
    createRuntimeDaemon: () => daemon,
    createRuntimeApiServer: () => apiServer,
    registerSignalHandler: (signal, handler) => {
      signalHandlers.set(signal, handler);
    },
    setKeepAlive: (() =>
      ({ kind: "keepalive" } as unknown as ReturnType<typeof setInterval>)) as typeof setInterval,
    clearKeepAlive: (() => undefined) as typeof clearInterval,
    exit: ((_: number) => {
      exitCalls += 1;
      return undefined as never;
    }) as (code: number) => never,
    log: () => undefined,
  });

  daemon.enqueueRun(createRunInput());
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (supervisor.launchRequested > 0) {
      break;
    }

    await waitForAsyncTurn();
  }

  assert.equal(supervisor.launchRequested, 1);
  signalHandlers.get("SIGTERM")?.();
  await waitForAsyncTurn();

  assert.equal(exitCalls, 0);
  assert.equal(supervisor.terminated, 0);

  supervisor.resolveLaunch();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (exitCalls > 0) {
      break;
    }

    await waitForAsyncTurn();
  }

  assert.equal(supervisor.terminated, 1);
  assert.equal(exitCalls, 1);
});

function createRepository(t: TestContext): RuntimeRepository {
  return createRepositoryFixture(t).repository;
}

function createRepositoryFixture(t: TestContext): {
  database: ReturnType<typeof openRuntimeDatabase>;
  repository: RuntimeRepository;
} {
  const fixture = createRuntimeFixture(t);
  const database = openRuntimeDatabase(fixture.runtimeConfig.databasePath);
  t.after(() => database.close());

  return {
    database,
    repository: new RuntimeRepository(database.connection),
  };
}

function createRuntimeFixture(t: TestContext): RuntimeFixture {
  const rootDir = mkdtempSync(path.join(tmpdir(), "orq-runtime-"));
  t.after(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  return {
    rootDir,
    runtimeConfig: {
      sourcePath: path.join(rootDir, "config.toml"),
      profileName: "test",
      stateDir: path.join(rootDir, "state"),
      logDir: path.join(rootDir, "logs"),
      runtimeLogDir: path.join(rootDir, "logs", "runtime"),
      databasePath: path.join(rootDir, "state", "runtime.sqlite"),
      policy: {
        maxConcurrentRuns: 4,
        maxRunsPerProvider: 2,
        allowMixedProviders: true,
        defaultPhaseTimeoutSec: 5400,
      },
    },
  };
}

function createRunInput(
  overrides: {
    runId?: string;
    phase?: CreateRunInput["phase"];
    provider?: CreateRunInput["provider"];
    requestedBy?: string | null;
    workItem?: Partial<CreateRunInput["workItem"]>;
    workspace?: Partial<CreateRunInput["workspace"]>;
  } = {},
): CreateRunInput {
  return {
    runId: overrides.runId ?? "run-001",
    phase: overrides.phase ?? "implement",
    workItem: {
      id: overrides.workItem?.id ?? "issue-1",
      identifier: overrides.workItem?.identifier ?? "ORQ-32",
      title: "Scaffold runtime daemon package, SQLite schema, and run repository",
      description: "Persist queued runs locally.",
      labels: ["runtime"],
      url: "https://linear.app/orqestrate/issue/ORQ-32",
    },
    provider: overrides.provider ?? "codex",
    workspace: {
      repoRoot: overrides.workspace?.repoRoot ?? "/repo",
      mode: overrides.workspace?.mode ?? "ephemeral_worktree",
      workingDirHint:
        overrides.workspace?.workingDirHint ?? "/repo/.worktrees/run-001",
      baseRef: overrides.workspace?.baseRef ?? "main",
    },
    prompt: {
      contractId: "orqestrate/implement/v1",
      userPrompt: "Implement ORQ-32.",
      attachments: [],
      sources: [],
      digests: {
        system: "sha256-system",
        user: "sha256-user",
      },
    },
    limits: {
      maxWallTimeSec: 5400,
      idleTimeoutSec: 300,
      bootstrapTimeoutSec: 120,
    },
    requestedBy: overrides.requestedBy ?? "Kimball Hill",
  };
}

function createLoadedConfigFixture(): LoadedConfig {
  return {
    sourcePath: "/tmp/config.toml",
    version: 1 as const,
    env: {},
    paths: {
      stateDir: "/tmp/state",
      dataDir: "/tmp/data",
      logDir: "/tmp/logs",
    },
    policy: {
      maxConcurrentRuns: 4,
      maxRunsPerProvider: 2,
      allowMixedProviders: true,
      defaultPhaseTimeoutSec: 5400,
    },
    prompts: {
      root: "/tmp/prompts",
      activePack: "default",
    },
    promptPacks: {
      default: {
        name: "default",
        baseSystem: "/tmp/prompts/base/system.md",
        roles: {},
        phases: {},
        capabilities: {},
        overlays: {
          organization: {},
          project: {},
        },
        experiments: {},
      },
    },
    providers: {},
    profiles: {
      local: {
        name: "local",
        planningProviderName: "local_planning",
        contextProviderName: "local_context",
        promptPackName: "default",
        planningProvider: {
          name: "local_planning",
          kind: "planning.local_files",
          family: "planning",
          root: "/tmp/planning",
        },
        contextProvider: {
          name: "local_context",
          kind: "context.local_files",
          family: "context",
          root: "/tmp/context",
          templates: {},
        },
        promptPack: {
          name: "default",
          baseSystem: "/tmp/prompts/base/system.md",
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
            baseSystem: "/tmp/prompts/base/system.md",
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
    },
    activeProfileName: "local",
    activeProfile: {
      name: "local",
      planningProviderName: "local_planning",
      contextProviderName: "local_context",
      promptPackName: "default",
      planningProvider: {
        name: "local_planning",
        kind: "planning.local_files",
        family: "planning",
        root: "/tmp/planning",
      },
      contextProvider: {
        name: "local_context",
        kind: "context.local_files",
        family: "context",
        root: "/tmp/context",
        templates: {},
      },
      promptPack: {
        name: "default",
        baseSystem: "/tmp/prompts/base/system.md",
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
          baseSystem: "/tmp/prompts/base/system.md",
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

class DelayedLaunchSessionSupervisor implements SessionSupervisor {
  launchRequested = 0;
  terminated = 0;
  private pendingLaunch:
    | {
        observer: SessionObserver;
        resolve: (handle: { sessionId: string; pid: number; runId: string }) => void;
      }
    | null = null;

  async launch(
    _spec: LaunchSpec,
    observer: SessionObserver,
  ): Promise<{ sessionId: string; pid: number; runId: string }> {
    this.launchRequested += 1;
    return new Promise((resolve) => {
      this.pendingLaunch = { observer, resolve };
    });
  }

  resolveLaunch(): void {
    assert.ok(this.pendingLaunch);
    const { observer, resolve } = this.pendingLaunch;
    this.pendingLaunch = null;
    resolve({
      sessionId: "delayed-session-1",
      pid: 5252,
      runId: observer.runId,
    });
  }

  async write(_sessionId: string, _input: string): Promise<void> {}

  async interrupt(_sessionId: string): Promise<void> {}

  async terminate(_sessionId: string): Promise<void> {
    this.terminated += 1;
  }

  async snapshot(sessionId: string): Promise<SessionSnapshot> {
    return {
      sessionId,
      runId: "run-001",
      pid: 5252,
      recentOutput: "",
      bytesRead: 0,
      bytesWritten: 0,
      isAlive: false,
      startedAt: "2026-04-14T18:00:00.000Z",
      lastOutputAt: null,
      lastInputAt: null,
    };
  }

  async readRecentOutput(_sessionId: string, _maxChars: number): Promise<string> {
    return "";
  }
}
