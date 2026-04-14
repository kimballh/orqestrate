import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { buildRuntimeProviderError, type HumanInput, type OutputEvent, type ProviderAdapter, type RunOutcome, type RuntimeSessionController, type RuntimeSignal } from "./provider-adapter.js";
import { RunExecutor } from "./run-executor.js";
import { RuntimeAdapterRegistry } from "./runtime-adapter-registry.js";
import type { LaunchSpec, SessionExit, SessionObserver, SessionSnapshot, SessionSupervisor } from "./session-supervisor.js";
import { openRuntimeDatabase } from "./persistence/database.js";
import { RuntimeRepository } from "./persistence/runtime-repository.js";
import type { CreateRunInput, ExecutableRunRecord } from "./types.js";

test("claimNextQueuedRun preserves the prompt envelope for execution", (t) => {
  const { repository } = createRepositoryFixture(t);
  const createdRun = repository.enqueueRun(createRunInput());
  const claimedRun = repository.claimNextQueuedRun({
    runtimeOwner: "runtime-daemon",
  });

  assert.ok(claimedRun);
  assert.equal(claimedRun.runId, createdRun.runId);
  assert.equal(claimedRun.status, "admitted");
  assert.equal(claimedRun.prompt.userPrompt, "Implement ORQ-33.");
});

test("stale recovery only marks active sessions and leaves queued runs alone", (t) => {
  const { repository } = createRepositoryFixture(t);
  const activeRun = repository.enqueueRun(createRunInput());
  const queuedRun = repository.enqueueRun(
    createRunInput({
      runId: "run-002",
    }),
  );

  repository.claimNextQueuedRun({ runtimeOwner: "runtime-daemon" });
  repository.markAllNonTerminalRunsStaleOnRecovery({
    occurredAt: "2026-04-14T18:00:00.000Z",
  });

  assert.equal(repository.getRun(queuedRun.runId)?.status, "queued");
  assert.equal(repository.getRun(activeRun.runId)?.status, "stale");
});

test("run executor drives a claimed run to completion and records evidence", async (t) => {
  const { fixture, database, repository } = createRepositoryFixture(t);
  const registry = new RuntimeAdapterRegistry().register(
    "codex",
    () => new FakeProviderAdapter(),
  );
  const supervisor = new FakeSessionSupervisor();
  const executor = new RunExecutor(
    repository,
    registry,
    supervisor,
    fixture.runtimeConfig.runtimeLogDir,
    {
      heartbeatFlushIntervalMs: 5,
      quietHeartbeatIntervalMs: 20,
      cancelGracePeriodMs: 5,
    },
  );
  repository.enqueueRun(createRunInput());
  const claimedRun = repository.claimNextQueuedRun({
    runtimeOwner: "runtime-daemon",
  }) as ExecutableRunRecord;

  const execution = executor.executeClaimedRun(claimedRun);
  await waitForAsyncTurn();

  assert.equal(repository.getRun(claimedRun.runId)?.status, "bootstrapping");

  supervisor.emitOutput("session-1", "READY\n");
  supervisor.emitOutput("session-1", "PROGRESS\n");
  supervisor.emitExit("session-1", 0, null);

  const completedRun = await execution;
  const events = repository.listRunEvents(claimedRun.runId);
  const heartbeatCount = database.connection
    .prepare("SELECT COUNT(*) AS count FROM session_heartbeats WHERE run_id = ?")
    .get(claimedRun.runId) as { count: number };
  const logContents = readFileSync(
    path.join(fixture.runtimeConfig.runtimeLogDir, claimedRun.runId, "session.log"),
    "utf8",
  );

  assert.equal(completedRun.status, "completed");
  assert.ok(events.some((event) => event.eventType === "run_admitted"));
  assert.ok(events.some((event) => event.eventType === "session_ready"));
  assert.ok(events.some((event) => event.eventType === "progress_update"));
  assert.ok(heartbeatCount.count >= 1);
  assert.match(logContents, /READY/);
  assert.match(logContents, /PROGRESS/);
});

test("run executor does not mark a session ready until the adapter or snapshot proves it", async (t) => {
  const { fixture, repository } = createRepositoryFixture(t);
  const registry = new RuntimeAdapterRegistry().register(
    "codex",
    () => new FakeProviderAdapter(),
  );
  const supervisor = new FakeSessionSupervisor();
  const executor = new RunExecutor(
    repository,
    registry,
    supervisor,
    fixture.runtimeConfig.runtimeLogDir,
    {
      heartbeatFlushIntervalMs: 5,
      quietHeartbeatIntervalMs: 20,
      cancelGracePeriodMs: 5,
    },
  );
  repository.enqueueRun(createRunInput());
  const claimedRun = repository.claimNextQueuedRun({
    runtimeOwner: "runtime-daemon",
  }) as ExecutableRunRecord;

  const execution = executor.executeClaimedRun(claimedRun);
  await waitForAsyncTurn();

  assert.equal(repository.getRun(claimedRun.runId)?.status, "bootstrapping");

  await executor.cancelRun(claimedRun.runId, "Stop the bootstrap test.");
  await execution;
});

test("run executor resumes waiting-human runs and supports cancellation", async (t) => {
  const { repository } = createRepositoryFixture(t);
  const registry = new RuntimeAdapterRegistry().register(
    "codex",
    () => new FakeProviderAdapter(),
  );
  const supervisor = new FakeSessionSupervisor();
  const executor = new RunExecutor(
    repository,
    registry,
    supervisor,
    createRuntimeFixture(t).runtimeConfig.runtimeLogDir,
    {
      heartbeatFlushIntervalMs: 5,
      quietHeartbeatIntervalMs: 20,
      cancelGracePeriodMs: 5,
    },
  );
  repository.enqueueRun(createRunInput());
  const claimedRun = repository.claimNextQueuedRun({
    runtimeOwner: "runtime-daemon",
  }) as ExecutableRunRecord;

  const execution = executor.executeClaimedRun(claimedRun);
  await waitForAsyncTurn();

  supervisor.emitOutput("session-1", "NEEDS_HUMAN\n");
  await waitForAsyncTurn();
  assert.equal(repository.getRun(claimedRun.runId)?.status, "waiting_human");

  const updatedRun = await executor.submitHumanInput(claimedRun.runId, {
    kind: "answer",
    message: "Proceed with the existing abstraction.",
  });
  assert.equal(updatedRun.status, "running");

  await executor.cancelRun(
    claimedRun.runId,
    "Operator canceled the run.",
    "Kimball Hill",
  );
  const canceledRun = await execution;
  const events = repository.listRunEvents(claimedRun.runId);

  assert.equal(canceledRun.status, "canceled");
  assert.ok(events.some((event) => event.eventType === "waiting_human"));
  assert.ok(events.some((event) => event.eventType === "human_input_received"));
  assert.ok(events.some((event) => event.eventType === "cancel_requested"));
});

test("cancel before launch reaches a terminal canceled state", (t) => {
  const { repository } = createRepositoryFixture(t);
  const queuedRun = repository.enqueueRun(createRunInput());

  const canceledRun = repository.cancelRunBeforeLaunch({
    runId: queuedRun.runId,
    reason: "Human canceled before launch.",
    requestedBy: "Kimball Hill",
    occurredAt: "2026-04-14T18:10:00.000Z",
  });
  const events = repository.listRunEvents(queuedRun.runId);

  assert.equal(canceledRun.status, "canceled");
  assert.equal(canceledRun.outcome?.code, "canceled_before_launch");
  assert.ok(events.some((event) => event.eventType === "cancel_requested"));
  assert.ok(events.some((event) => event.eventType === "run_canceled"));
});

test("failed human input delivery keeps the run in waiting_human", async (t) => {
  const { repository } = createRepositoryFixture(t);
  const registry = new RuntimeAdapterRegistry().register(
    "codex",
    () => new FakeProviderAdapter({ failHumanInput: true }),
  );
  const supervisor = new FakeSessionSupervisor();
  const executor = new RunExecutor(
    repository,
    registry,
    supervisor,
    createRuntimeFixture(t).runtimeConfig.runtimeLogDir,
    {
      heartbeatFlushIntervalMs: 5,
      quietHeartbeatIntervalMs: 20,
      cancelGracePeriodMs: 5,
    },
  );
  repository.enqueueRun(createRunInput());
  const claimedRun = repository.claimNextQueuedRun({
    runtimeOwner: "runtime-daemon",
  }) as ExecutableRunRecord;

  const execution = executor.executeClaimedRun(claimedRun);
  await waitForAsyncTurn();

  supervisor.emitOutput("session-1", "NEEDS_HUMAN\n");
  await waitForAsyncTurn();

  await assert.rejects(
    () =>
      executor.submitHumanInput(claimedRun.runId, {
        kind: "answer",
        message: "This should fail to deliver.",
      }),
    /fake human input failure/,
  );

  assert.equal(repository.getRun(claimedRun.runId)?.status, "waiting_human");

  await executor.cancelRun(claimedRun.runId, "Stop after failed input.");
  await execution;
});

type RuntimeFixture = {
  rootDir: string;
  runtimeConfig: {
    sourcePath: string;
    profileName: string;
    stateDir: string;
    logDir: string;
    runtimeLogDir: string;
    databasePath: string;
    policy: {
      maxConcurrentRuns: number;
      maxRunsPerProvider: number;
      allowMixedProviders: boolean;
      defaultPhaseTimeoutSec: number;
    };
  };
};

class FakeSessionSupervisor implements SessionSupervisor {
  private readonly sessions = new Map<
    string,
    {
      runId: string;
      observer: SessionObserver;
      recentOutput: string;
      bytesRead: number;
      bytesWritten: number;
      startedAt: string;
      isAlive: boolean;
      exit: SessionExit | null;
    }
  >();

  async launch(
    _spec: LaunchSpec,
    observer: SessionObserver,
  ): Promise<{ sessionId: string; pid: number; runId: string }> {
    this.sessions.set("session-1", {
      runId: observer.runId,
      observer,
      recentOutput: "",
      bytesRead: 0,
      bytesWritten: 0,
      startedAt: "2026-04-14T18:00:00.000Z",
      isAlive: true,
      exit: null,
    });

    return {
      sessionId: "session-1",
      pid: 4242,
      runId: observer.runId,
    };
  }

  async write(sessionId: string, input: string): Promise<void> {
    const session = this.requireSession(sessionId);
    session.bytesWritten += Buffer.byteLength(input);
  }

  async interrupt(_sessionId: string): Promise<void> {}

  async terminate(sessionId: string): Promise<void> {
    this.emitExit(sessionId, 130, "SIGTERM");
  }

  async snapshot(sessionId: string): Promise<SessionSnapshot> {
    const session = this.requireSession(sessionId);

    return {
      sessionId,
      runId: session.runId,
      pid: 4242,
      recentOutput: session.recentOutput,
      bytesRead: session.bytesRead,
      bytesWritten: session.bytesWritten,
      isAlive: session.isAlive,
      startedAt: session.startedAt,
      lastOutputAt: session.exit?.occurredAt ?? null,
      lastInputAt: null,
    };
  }

  async readRecentOutput(sessionId: string, maxChars: number): Promise<string> {
    const session = this.requireSession(sessionId);
    return session.recentOutput.slice(Math.max(0, session.recentOutput.length - maxChars));
  }

  emitOutput(sessionId: string, chunk: string): void {
    const session = this.requireSession(sessionId);
    session.recentOutput += chunk;
    session.bytesRead += Buffer.byteLength(chunk);
    void session.observer.onOutput({
      sessionId,
      occurredAt: "2026-04-14T18:00:01.000Z",
      chunk,
    });
  }

  emitExit(
    sessionId: string,
    exitCode: number | null,
    signal: string | null,
  ): void {
    const session = this.requireSession(sessionId);

    if (!session.isAlive) {
      return;
    }

    session.isAlive = false;
    session.exit = {
      sessionId,
      occurredAt: "2026-04-14T18:00:02.000Z",
      exitCode,
      signal,
    };
    void session.observer.onExit(session.exit);
  }

  private requireSession(sessionId: string) {
    const session = this.sessions.get(sessionId);

    assert.ok(session);
    return session;
  }
}

class FakeProviderAdapter implements ProviderAdapter {
  readonly kind = "codex" as const;

  constructor(
    private readonly options: {
      failHumanInput?: boolean;
    } = {},
  ) {}

  buildLaunchSpec(input: { cwd: string }): LaunchSpec {
    return {
      command: "fake-agent",
      args: [],
      env: {},
      cwd: input.cwd,
    };
  }

  detectReady(snapshot: SessionSnapshot): boolean {
    return snapshot.recentOutput.includes("READY");
  }

  classifyOutput(event: OutputEvent): RuntimeSignal[] {
    const signals: RuntimeSignal[] = [];

    if (event.chunk.includes("READY")) {
      signals.push({
        type: "ready",
        payload: {
          source: "fake-output",
        },
      });
    }

    if (event.chunk.includes("PROGRESS")) {
      signals.push({
        type: "progress",
        eventType: "progress_update",
        payload: {
          chunk: event.chunk.trim(),
        },
      });
    }

    if (event.chunk.includes("NEEDS_HUMAN")) {
      signals.push({
        type: "waiting_human",
        reason: "Need an operator decision.",
      });
    }

    return signals;
  }

  async submitInitialPrompt(
    session: RuntimeSessionController,
    prompt: { userPrompt: string },
  ): Promise<void> {
    await session.write(`${prompt.userPrompt}\n`);
  }

  async submitHumanInput(
    session: RuntimeSessionController,
    input: HumanInput,
  ): Promise<void> {
    if (this.options.failHumanInput === true) {
      throw new Error("fake human input failure");
    }

    await session.write(`${input.message}\n`);
  }

  async interrupt(session: RuntimeSessionController): Promise<void> {
    await session.interrupt();
  }

  async cancel(session: RuntimeSessionController): Promise<void> {
    await session.terminate(true);
  }

  async collectOutcome(
    _session: RuntimeSessionController,
    exit: SessionExit | null,
  ): Promise<RunOutcome> {
    if (exit?.exitCode === 0) {
      return {
        status: "completed",
        code: "completed",
        exitCode: 0,
        summary: "Run completed.",
      };
    }

    return {
      status: "canceled",
      code: "canceled",
      exitCode: exit?.exitCode ?? null,
      summary: "Run canceled.",
      error: buildRuntimeProviderError({
        providerKind: "codex",
        code: "transport",
        message: "Canceled by the fake adapter.",
        retryable: false,
      }),
    };
  }
}

function createRepositoryFixture(t: TestContext): {
  fixture: RuntimeFixture;
  database: ReturnType<typeof openRuntimeDatabase>;
  repository: RuntimeRepository;
} {
  const fixture = createRuntimeFixture(t);
  const database = openRuntimeDatabase(fixture.runtimeConfig.databasePath);
  t.after(() => database.close());

  return {
    fixture,
    database,
    repository: new RuntimeRepository(database.connection),
  };
}

function createRuntimeFixture(t: TestContext): RuntimeFixture {
  const rootDir = mkdtempSync(path.join(tmpdir(), "orq-runtime-executor-"));
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
  } = {},
): CreateRunInput {
  return {
    runId: overrides.runId ?? "run-001",
    phase: overrides.phase ?? "implement",
    workItem: {
      id: "issue-1",
      identifier: "ORQ-33",
      title: "Implement PTY session supervisor abstraction and host process control",
      description: "Add the runtime execution seam.",
      labels: ["runtime"],
      url: "https://linear.app/orqestrate/issue/ORQ-33",
    },
    provider: overrides.provider ?? "codex",
    workspace: {
      repoRoot: "/repo",
      mode: "ephemeral_worktree",
      workingDirHint: "/repo/.worktrees/run-001",
      baseRef: "main",
    },
    prompt: {
      contractId: "orqestrate/implement/v1",
      userPrompt: "Implement ORQ-33.",
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
    requestedBy: "Kimball Hill",
  };
}

async function waitForAsyncTurn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
