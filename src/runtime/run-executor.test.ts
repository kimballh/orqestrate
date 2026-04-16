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
  await new Promise((resolve) => setTimeout(resolve, 10));
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

test("run executor prepares the worktree and runs the setup hook before launch", async (t) => {
  const { fixture, repository } = createRepositoryFixture(t);
  const registry = new RuntimeAdapterRegistry().register(
    "codex",
    () => new FakeProviderAdapter(),
  );
  const supervisor = new FakeSessionSupervisor();
  const hookPath = "/repo/.worktrees/run-001/scripts/codex-setup.sh";
  const workspaceHarness = createWorkspaceOperationsHarness({
    hookPath,
  });
  const executor = new RunExecutor(
    repository,
    registry,
    supervisor,
    fixture.runtimeConfig.runtimeLogDir,
    {
      heartbeatFlushIntervalMs: 5,
      quietHeartbeatIntervalMs: 20,
      cancelGracePeriodMs: 5,
      workspaceOperations: workspaceHarness.operations,
    },
  );
  repository.enqueueRun(
    createRunInput({
      workspace: {
        mode: "ephemeral_worktree",
        workingDirHint: "/repo/.worktrees/run-001",
      },
    }),
  );
  const claimedRun = repository.claimNextQueuedRun({
    runtimeOwner: "runtime-daemon",
  }) as ExecutableRunRecord;

  const execution = executor.executeClaimedRun(claimedRun);
  await waitForAsyncTurn();

  assert.equal(supervisor.launchSpecs.length, 1);
  assert.equal(supervisor.launchSpecs[0]?.cwd, "/repo/.worktrees/run-001");
  assert.equal(workspaceHarness.commands[0]?.command, "git");
  assert.deepEqual(workspaceHarness.commands[0]?.args, [
    "-C",
    "/repo",
    "worktree",
    "add",
    "--detach",
    "/repo/.worktrees/run-001",
    "main",
  ]);
  assert.equal(workspaceHarness.commands[1]?.command, "bash");
  assert.equal(workspaceHarness.commands[1]?.cwd, "/repo/.worktrees/run-001");
  assert.equal(
    workspaceHarness.commands[1]?.env?.ORQESTRATE_REPO_ROOT,
    "/repo/.worktrees/run-001",
  );
  assert.equal(
    workspaceHarness.commands[1]?.env?.ORQESTRATE_SOURCE_REPO_ROOT,
    "/repo",
  );

  const preparedRun = repository.getRun(claimedRun.runId);
  assert.equal(preparedRun?.workspace.allocationId, "workspace-run-001");
  assert.equal(preparedRun?.workspace.workingDir, "/repo/.worktrees/run-001");
  assert.equal(
    repository.getWorkspaceAllocation("workspace-run-001")?.status,
    "in_use",
  );

  supervisor.emitOutput("session-1", "READY\n");
  await waitForAsyncTurn();
  supervisor.emitExit("session-1", 0, null);

  const completedRun = await execution;
  const events = repository
    .listRunEvents(claimedRun.runId)
    .map((event) => event.eventType);

  assert.equal(completedRun.status, "completed");
  assert.equal(
    repository.getWorkspaceAllocation("workspace-run-001")?.status,
    "released",
  );
  assert.ok(events.includes("workspace_preparation_started"));
  assert.ok(events.includes("workspace_setup_hook_started"));
  assert.ok(events.includes("workspace_setup_hook_completed"));
  assert.ok(events.includes("workspace_prepared"));
  assert.ok(events.includes("workspace_released"));
  assert.equal(workspaceHarness.commands.at(-1)?.command, "git");
  assert.deepEqual(workspaceHarness.commands.at(-1)?.args, [
    "-C",
    "/repo",
    "worktree",
    "remove",
    "--force",
    "/repo/.worktrees/run-001",
  ]);
});

test("workspace setup hook failures stop the run before provider launch", async (t) => {
  const { fixture, repository } = createRepositoryFixture(t);
  const registry = new RuntimeAdapterRegistry().register(
    "codex",
    () => new FakeProviderAdapter(),
  );
  const supervisor = new FakeSessionSupervisor();
  const workspaceHarness = createWorkspaceOperationsHarness({
    hookPath: "/repo/.worktrees/run-001/scripts/codex-setup.sh",
    failSetup: true,
  });
  const executor = new RunExecutor(
    repository,
    registry,
    supervisor,
    fixture.runtimeConfig.runtimeLogDir,
    {
      heartbeatFlushIntervalMs: 5,
      quietHeartbeatIntervalMs: 20,
      cancelGracePeriodMs: 5,
      workspaceOperations: workspaceHarness.operations,
    },
  );
  repository.enqueueRun(
    createRunInput({
      workspace: {
        mode: "ephemeral_worktree",
        workingDirHint: "/repo/.worktrees/run-001",
      },
    }),
  );
  const claimedRun = repository.claimNextQueuedRun({
    runtimeOwner: "runtime-daemon",
  }) as ExecutableRunRecord;

  const failedRun = await executor.executeClaimedRun(claimedRun);
  const events = repository.listRunEvents(claimedRun.runId);

  assert.equal(supervisor.launchSpecs.length, 0);
  assert.equal(failedRun.status, "failed");
  assert.equal(failedRun.outcome?.code, "workspace_preparation_failed");
  assert.match(failedRun.outcome?.summary ?? "", /setup hook failed/);
  assert.equal(
    repository.getWorkspaceAllocation("workspace-run-001")?.status,
    "released",
  );
  assert.ok(
    events.some((event) => event.eventType === "workspace_preparation_failed"),
  );
  assert.ok(events.some((event) => event.eventType === "workspace_released"));
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "runtime_issue_detected" &&
        event.source === "workspace",
    ),
  );
});

test("shutdown marks active runs stale and ignores later heartbeat ticks", async (t) => {
  const { fixture, database, repository } = createRepositoryFixture(t);
  const registry = new RuntimeAdapterRegistry().register(
    "codex",
    () => new FakeProviderAdapter(),
  );
  const supervisor = new FakeSessionSupervisor();
  let heartbeatTick: (() => void) | null = null;
  let heartbeatCleared = false;
  const executor = new RunExecutor(
    repository,
    registry,
    supervisor,
    fixture.runtimeConfig.runtimeLogDir,
    {
      heartbeatFlushIntervalMs: 5,
      quietHeartbeatIntervalMs: 20,
      cancelGracePeriodMs: 5,
      setInterval: ((callback: () => void) => {
        heartbeatTick = callback;
        return { kind: "heartbeat-timer" } as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearInterval: (() => {
        heartbeatCleared = true;
      }) as typeof clearInterval,
    },
  );
  repository.enqueueRun(createRunInput());
  const claimedRun = repository.claimNextQueuedRun({
    runtimeOwner: "runtime-daemon",
  }) as ExecutableRunRecord;

  const execution = executor.executeClaimedRun(claimedRun);
  await waitForAsyncTurn();

  supervisor.emitOutput("session-1", "READY\n");
  await waitForAsyncTurn();
  assert.equal(repository.getRun(claimedRun.runId)?.status, "running");
  assert.ok(heartbeatTick !== null);

  await executor.shutdown();
  const staleRun = await execution;

  assert.equal(staleRun.status, "stale");
  assert.equal(heartbeatCleared, true);

  database.close();
  assert.doesNotThrow(() => heartbeatTick?.());
});

test("shutdown terminates a session that launches after the run is already stale", async (t) => {
  const { fixture, repository } = createRepositoryFixture(t);
  const registry = new RuntimeAdapterRegistry().register(
    "codex",
    () => new FakeProviderAdapter(),
  );
  const supervisor = new DelayedLaunchSessionSupervisor();
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
  const shutdown = executor.shutdown();

  const staleRun = await execution;
  assert.equal(staleRun.status, "stale");
  assert.equal(supervisor.launched, 0);
  assert.equal(supervisor.terminated, 0);

  supervisor.resolveLaunch();
  await shutdown;

  assert.equal(supervisor.launched, 1);
  assert.equal(supervisor.terminated, 1);
  assert.equal(repository.getRun(claimedRun.runId)?.status, "stale");
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

test("human input rejects before adapter delivery when the run is not waiting", async (t) => {
  const { fixture, repository } = createRepositoryFixture(t);
  const adapter = new FakeProviderAdapter();
  const registry = new RuntimeAdapterRegistry().register("codex", () => adapter);
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
  supervisor.emitOutput("session-1", "READY\n");
  await waitForAsyncTurn();

  await assert.rejects(
    () =>
      executor.submitHumanInput(claimedRun.runId, {
        kind: "answer",
        message: "This should be rejected before delivery.",
      }),
    /not waiting for human input/,
  );

  assert.equal(adapter.humanInputCalls, 0);

  await executor.cancelRun(claimedRun.runId, "Stop after rejected input.");
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
      merge: {
        allowedMethods: string[];
        requireHumanApproval: boolean;
      };
    };
  };
};

class FakeSessionSupervisor implements SessionSupervisor {
  launchSpecs: LaunchSpec[] = [];
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
    spec: LaunchSpec,
    observer: SessionObserver,
  ): Promise<{ sessionId: string; pid: number; runId: string }> {
    this.launchSpecs.push(structuredClone(spec));
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

class DelayedLaunchSessionSupervisor implements SessionSupervisor {
  launched = 0;
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
    return new Promise((resolve) => {
      this.pendingLaunch = { observer, resolve };
    });
  }

  resolveLaunch(): void {
    assert.ok(this.pendingLaunch);
    const { observer, resolve } = this.pendingLaunch;
    this.pendingLaunch = null;
    this.launched += 1;
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
    await Promise.resolve();
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

class FakeProviderAdapter implements ProviderAdapter {
  readonly kind = "codex" as const;
  humanInputCalls = 0;

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
    this.humanInputCalls += 1;

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

function createWorkspaceOperationsHarness(options: {
  hookPath?: string;
  failSetup?: boolean;
} = {}): {
  commands: Array<{
    command: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }>;
  operations: {
    exists(filePath: string): boolean;
    mkdir(dirPath: string): void;
    removeDir(dirPath: string): void;
    runCommand(input: {
      command: string;
      args: string[];
      cwd: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    }): Promise<{ stdout: string; stderr: string }>;
  };
} {
  const existingPaths = new Set<string>(
    options.hookPath === undefined ? [] : [options.hookPath],
  );
  const commands: Array<{
    command: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }> = [];

  return {
    commands,
    operations: {
      exists: (filePath) => existingPaths.has(filePath),
      mkdir: () => undefined,
      removeDir: (dirPath) => {
        existingPaths.delete(dirPath);
      },
      runCommand: async (input) => {
        commands.push({
          command: input.command,
          args: [...input.args],
          cwd: input.cwd,
          env: input.env === undefined ? undefined : { ...input.env },
          timeoutMs: input.timeoutMs,
        });

        if (input.command === "git" && input.args[2] === "worktree") {
          const workingDir = input.args[5];
          if (input.args[3] === "add") {
            existingPaths.add(workingDir);
            return {
              stdout: "",
              stderr: "",
            };
          }

          existingPaths.delete(workingDir);
          return {
            stdout: "",
            stderr: "",
          };
        }

        if (input.command === "bash") {
          if (options.failSetup === true) {
            throw new Error("setup hook failed");
          }

          return {
            stdout: "bootstrap complete",
            stderr: "",
          };
        }

        return {
          stdout: "",
          stderr: "",
        };
      },
    },
  };
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
        merge: {
          allowedMethods: ["squash"],
          requireHumanApproval: false,
        },
      },
    },
  };
}

function createRunInput(
  overrides: {
    runId?: string;
    phase?: CreateRunInput["phase"];
    provider?: CreateRunInput["provider"];
    workspace?: Partial<CreateRunInput["workspace"]>;
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
      repoRoot: overrides.workspace?.repoRoot ?? "/repo",
      mode: overrides.workspace?.mode ?? "shared_readonly",
      workingDirHint: overrides.workspace?.workingDirHint ?? "/repo",
      baseRef: overrides.workspace?.baseRef ?? "main",
      assignedBranch:
        overrides.workspace?.assignedBranch ??
        "hillkimball/orq-33-implement-pty-session-supervisor-abstraction-and-host-process-control",
      pullRequestUrl:
        overrides.workspace?.pullRequestUrl ??
        "https://github.com/kimballh/orqestrate/pull/33",
      pullRequestMode: overrides.workspace?.pullRequestMode ?? "draft",
      writeScope: overrides.workspace?.writeScope ?? "repo",
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
    grantedCapabilities: ["github.read_pr", "github.push_branch"],
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
