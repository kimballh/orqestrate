import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { ProviderError, RunStatus, WorkspaceMode } from "../domain-model.js";
import { RuntimeError } from "./errors.js";
import { LiveRunRegistry } from "./live-run-registry.js";
import {
  buildRuntimeProviderError,
  type HumanInput,
  type OutputEvent,
  type ProviderAdapter,
  type RunOutcome,
  type RuntimeSessionController,
  type RuntimeSignal,
} from "./provider-adapter.js";
import { RuntimeAdapterRegistry } from "./runtime-adapter-registry.js";
import type {
  SessionExit,
  SessionOutputChunk,
  SessionSupervisor,
} from "./session-supervisor.js";
import type {
  ExecutableRunRecord,
  PersistedRunRecord,
  RunEventSource,
  WorkspaceAllocationRecord,
} from "./types.js";
import { RuntimeRepository } from "./persistence/runtime-repository.js";

const execFileAsync = promisify(execFile);

const SETUP_HOOK_CANDIDATES = [
  ".codex/setup.sh",
  ".codex/scripts/setup.sh",
  ".codex/local-environment-setup.sh",
  ".codex/worktree-setup.sh",
  "scripts/codex-setup.sh",
] as const;

type WorkspaceCommandInput = {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

type WorkspaceCommandResult = {
  stdout: string;
  stderr: string;
};

type WorkspaceOperations = {
  exists(filePath: string): boolean;
  mkdir(dirPath: string): void;
  removeDir(dirPath: string): void;
  runCommand(input: WorkspaceCommandInput): Promise<WorkspaceCommandResult>;
};

type PreparedWorkspaceState = {
  allocationId: string;
  mode: WorkspaceMode;
  workingDir: string;
  worktreeCreated: boolean;
  setupHookPath: string | null;
  cleanupComplete: boolean;
};

class WorkspacePreparationError extends Error {
  readonly providerError: ProviderError;
  readonly outcomeCode: string;
  readonly payload: Record<string, unknown>;

  constructor(input: {
    message: string;
    providerError: ProviderError;
    outcomeCode?: string;
    payload?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "WorkspacePreparationError";
    this.providerError = input.providerError;
    this.outcomeCode = input.outcomeCode ?? "workspace_preparation_failed";
    this.payload = input.payload ?? {};
  }
}

type RunExecutorDependencies = {
  now?: () => string;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  heartbeatFlushIntervalMs?: number;
  quietHeartbeatIntervalMs?: number;
  cancelGracePeriodMs?: number;
  runtimeApiEndpoint?: string | null;
  workspaceOperations?: WorkspaceOperations;
  createWorkspaceAllocationId?: (runId: string) => string;
};

type LiveRunContext = {
  run: ExecutableRunRecord;
  adapter: ProviderAdapter;
  controller: RuntimeSessionController | null;
  logFilePath: string;
  currentRun: PersistedRunRecord;
  preparedWorkspace: PreparedWorkspaceState | null;
  pendingHeartbeat: {
    bytesRead: number;
    bytesWritten: number;
  };
  lastHeartbeatEmissionAt: number;
  ready: boolean;
  finishing: boolean;
  exit: SessionExit | null;
  forcedOutcome: RunOutcome | null;
  cancelRequested:
    | {
        reason: string;
        requestedBy?: string | null;
      }
    | null;
  heartbeatTimer: ReturnType<typeof globalThis.setInterval> | null;
  bootstrapTimer: ReturnType<typeof globalThis.setTimeout> | null;
  cancelTimer: ReturnType<typeof globalThis.setTimeout> | null;
  resolve: (run: PersistedRunRecord) => void;
  reject: (error: unknown) => void;
};

const TERMINAL_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "canceled",
  "stale",
]);

export class RunExecutor {
  private readonly liveRuns = new LiveRunRegistry<LiveRunContext>();
  private readonly activeContexts = new Map<string, LiveRunContext>();
  private readonly executionTasks = new Map<string, Promise<void>>();
  private readonly now: () => string;
  private readonly setIntervalFn: typeof globalThis.setInterval;
  private readonly clearIntervalFn: typeof globalThis.clearInterval;
  private readonly setTimeoutFn: typeof globalThis.setTimeout;
  private readonly clearTimeoutFn: typeof globalThis.clearTimeout;
  private readonly heartbeatFlushIntervalMs: number;
  private readonly quietHeartbeatIntervalMs: number;
  private readonly cancelGracePeriodMs: number;
  private readonly runtimeApiEndpoint: string | null;
  private readonly workspaceOperations: WorkspaceOperations;
  private readonly createWorkspaceAllocationId: (runId: string) => string;

  constructor(
    private readonly repository: RuntimeRepository,
    private readonly adapterRegistry: RuntimeAdapterRegistry,
    private readonly supervisor: SessionSupervisor,
    private readonly runtimeLogDir: string,
    dependencies: RunExecutorDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.setIntervalFn = dependencies.setInterval ?? globalThis.setInterval;
    this.clearIntervalFn = dependencies.clearInterval ?? globalThis.clearInterval;
    this.setTimeoutFn = dependencies.setTimeout ?? globalThis.setTimeout;
    this.clearTimeoutFn = dependencies.clearTimeout ?? globalThis.clearTimeout;
    this.heartbeatFlushIntervalMs = dependencies.heartbeatFlushIntervalMs ?? 5_000;
    this.quietHeartbeatIntervalMs = dependencies.quietHeartbeatIntervalMs ?? 30_000;
    this.cancelGracePeriodMs = dependencies.cancelGracePeriodMs ?? 2_000;
    this.runtimeApiEndpoint = dependencies.runtimeApiEndpoint ?? null;
    this.workspaceOperations =
      dependencies.workspaceOperations ?? createDefaultWorkspaceOperations();
    this.createWorkspaceAllocationId =
      dependencies.createWorkspaceAllocationId ??
      ((runId) => `workspace-${runId}`);
  }

  executeClaimedRun(run: ExecutableRunRecord): Promise<PersistedRunRecord> {
    return new Promise<PersistedRunRecord>((resolve, reject) => {
      const context: LiveRunContext = {
        run,
        adapter: this.adapterRegistry.create(run.provider),
        controller: null,
        logFilePath: this.createLogFilePath(run.runId),
        currentRun: run,
        preparedWorkspace: null,
        pendingHeartbeat: {
          bytesRead: 0,
          bytesWritten: 0,
        },
        lastHeartbeatEmissionAt: Date.now(),
        ready: false,
        finishing: false,
        exit: null,
        forcedOutcome: null,
        cancelRequested: null,
        heartbeatTimer: null,
        bootstrapTimer: null,
        cancelTimer: null,
        resolve,
        reject,
      };
      this.activeContexts.set(run.runId, context);
      const executionTask = this.executeInternal(context).catch(async (error) => {
        if (context.finishing) {
          reject(error);
          return;
        }

        await this.failContext(
          context,
          error instanceof Error ? error : new Error(String(error)),
        );
      });
      this.executionTasks.set(run.runId, executionTask);
      void executionTask.finally(() => {
        this.executionTasks.delete(run.runId);
      });
    });
  }

  hasLiveSession(runId: string): boolean {
    const context = this.liveRuns.getByRunId(runId);
    return context !== null && context.controller !== null;
  }

  async shutdown(
    reason = "Runtime daemon stopped before the live run finished.",
  ): Promise<void> {
    const cleanupTasks: Promise<unknown>[] = [];

    for (const context of [...this.activeContexts.values()]) {
      if (context.finishing) {
        continue;
      }

      context.finishing = true;
      this.clearTimers(context);
      this.liveRuns.removeByRunId(context.run.runId);

      if (!TERMINAL_STATUSES.has(context.currentRun.status)) {
        context.currentRun = this.repository.markRunStaleOnRecovery({
          runId: context.run.runId,
          occurredAt: this.now(),
          reason,
        });
      }

      this.activeContexts.delete(context.run.runId);
      const executionTask = this.executionTasks.get(context.run.runId);
      if (executionTask !== undefined) {
        cleanupTasks.push(executionTask);
      }

      if (context.controller !== null) {
        cleanupTasks.push(
          this.supervisor.terminate(context.controller.sessionId, true),
        );
        context.controller = null;
      }

      if (context.preparedWorkspace !== null) {
        cleanupTasks.push(
          this.cleanupPreparedWorkspace(
            context,
            "Runtime daemon stopped before the workspace could be released cleanly.",
          ),
        );
      }

      context.resolve(context.currentRun);
    }

    await Promise.allSettled(cleanupTasks);
  }

  async interruptRun(runId: string): Promise<PersistedRunRecord> {
    const context = this.liveRuns.getByRunId(runId);

    if (context === null || context.controller === null) {
      return this.requireRun(runId);
    }

    this.repository.appendRunEvent({
      runId,
      eventType: "interrupt_requested",
      level: "info",
      source: "api",
      occurredAt: this.now(),
      payload: {
        sessionId: context.controller.sessionId,
      },
    });
    await context.adapter.interrupt(context.controller);
    return this.requireRun(runId);
  }

  async cancelRun(
    runId: string,
    reason: string,
    requestedBy?: string | null,
  ): Promise<PersistedRunRecord> {
    const context =
      this.liveRuns.getByRunId(runId) ?? this.activeContexts.get(runId) ?? null;
    const run = this.requireRun(runId);

    if (TERMINAL_STATUSES.has(run.status)) {
      return run;
    }

    if (context === null) {
      return this.repository.cancelRunBeforeLaunch({
        runId,
        occurredAt: this.now(),
        reason,
        requestedBy: requestedBy ?? null,
      });
    }

    context.cancelRequested = { reason, requestedBy };
    if (context.controller === null) {
      context.currentRun = this.repository.cancelRunBeforeLaunch({
        runId,
        occurredAt: this.now(),
        reason,
        requestedBy: requestedBy ?? null,
      });
      context.finishing = true;
      return context.currentRun;
    }

    if (context.currentRun.status !== "stopping") {
      context.currentRun = this.repository.markRunStopping({
        runId,
        occurredAt: this.now(),
        payload: {
          reason,
          requestedBy: requestedBy ?? null,
        },
      });
    }

    await context.adapter.cancel(context.controller);
    this.scheduleCancelTermination(context);
    return this.requireRun(runId);
  }

  async submitHumanInput(
    runId: string,
    input: HumanInput,
  ): Promise<PersistedRunRecord> {
    const context = this.liveRuns.getByRunId(runId);

    if (context === null || context.controller === null) {
      throw new RuntimeError(`Run '${runId}' does not have a live session.`, {
        code: "live_session_not_found",
      });
    }

    const run = this.requireRun(runId);
    if (run.status !== "waiting_human" || context.currentRun.status !== "waiting_human") {
      throw new RuntimeError(
        `Run '${runId}' is not waiting for human input.`,
        {
          code: "invalid_run_state_transition",
        },
      );
    }

    await context.adapter.submitHumanInput(context.controller, input);
    context.pendingHeartbeat.bytesWritten += Buffer.byteLength(input.message);
    context.currentRun = this.repository.resumeRunFromWaitingHuman({
      runId,
      occurredAt: this.now(),
      payload: {
        kind: input.kind,
        author: input.author ?? null,
      },
    });
    return context.currentRun;
  }

  private async executeInternal(context: LiveRunContext): Promise<void> {
    if (context.run.workspace.mode === "ephemeral_worktree") {
      await this.prepareWorkspace(context);
    }

    if (context.finishing) {
      await this.cleanupPreparedWorkspace(
        context,
        "Run finished before provider launch started.",
      );
      this.resolveFinishingPrelaunchContext(context);
      return;
    }

    const cwd = resolveWorkingDirectory(context.run);
    const launchInput = {
      run: context.run,
      cwd,
      logFilePath: context.logFilePath,
      runtimeApiEndpoint: this.runtimeApiEndpoint,
    };
    const launchSpec = context.adapter.buildLaunchSpec(launchInput);

    context.currentRun = this.repository.markRunLaunching({
      runId: context.run.runId,
      occurredAt: this.now(),
      payload: {
        cwd,
        command: launchSpec.command,
        args: launchSpec.args,
      },
    });

    const handle = await this.supervisor.launch(launchSpec, {
      runId: context.run.runId,
      onOutput: async (event) => {
        await this.handleOutput(context, event);
      },
      onExit: async (event) => {
        await this.handleExit(context, event);
      },
    });

    if (context.finishing) {
      await this.supervisor.terminate(handle.sessionId, true);
      await this.cleanupPreparedWorkspace(
        context,
        "Run finished before provider launch completed.",
      );
      this.resolveFinishingPrelaunchContext(context);
      return;
    }

    await this.markWorkspaceInUse(context);

    context.controller = this.createSessionController(
      context.run.runId,
      handle.sessionId,
      context,
    );
    this.liveRuns.add(context.run.runId, handle.sessionId, context);

    context.currentRun = this.repository.markRunBootstrapping({
      runId: context.run.runId,
      occurredAt: this.now(),
      payload: {
        sessionId: handle.sessionId,
        pid: handle.pid,
      },
    });

    this.startHeartbeatLoop(context);
    this.startBootstrapTimer(context);
    await context.adapter.submitInitialPrompt(context.controller, context.run.prompt);
    await this.maybeMarkReady(context);
  }

  private async handleOutput(
    context: LiveRunContext,
    event: SessionOutputChunk,
  ): Promise<void> {
    if (context.finishing) {
      return;
    }

    appendFileSync(context.logFilePath, event.chunk);
    context.pendingHeartbeat.bytesRead += Buffer.byteLength(event.chunk);

    const signals = context.adapter.classifyOutput({
      ...event,
      runId: context.run.runId,
    });

    for (const signal of signals) {
      await this.handleSignal(context, signal);
    }

    if (!context.ready) {
      await this.maybeMarkReady(context);
    }
  }

  private async handleSignal(
    context: LiveRunContext,
    signal: RuntimeSignal,
  ): Promise<void> {
    if (TERMINAL_STATUSES.has(context.currentRun.status)) {
      return;
    }

    switch (signal.type) {
      case "ready":
        await this.maybeMarkReady(context, signal);
        return;
      case "progress":
        this.repository.appendRunEvent({
          runId: context.run.runId,
          eventType: signal.eventType,
          level: signal.level ?? "info",
          source: "provider",
          occurredAt: this.now(),
          payload: signal.payload ?? {},
        });
        return;
      case "waiting_human":
        if (context.currentRun.status !== "waiting_human") {
          context.currentRun = this.repository.markRunWaitingHuman({
            runId: context.run.runId,
            reason: signal.reason,
            occurredAt: this.now(),
            payload: signal.payload,
          });
        }
        return;
      case "runtime_issue":
        context.currentRun = this.repository.recordRuntimeIssue({
          runId: context.run.runId,
          error: signal.error,
          occurredAt: this.now(),
          payload: signal.payload,
        });
        return;
    }
  }

  private async maybeMarkReady(
    context: LiveRunContext,
    signal?: Extract<RuntimeSignal, { type: "ready" }>,
  ): Promise<void> {
    if (
      context.finishing ||
      context.controller === null ||
      context.ready ||
      context.currentRun.status !== "bootstrapping"
    ) {
      return;
    }

    const snapshot = await context.controller.snapshot();
    if (
      context.ready ||
      context.currentRun.status !== "bootstrapping" ||
      TERMINAL_STATUSES.has(context.currentRun.status)
    ) {
      return;
    }

    const isReady =
      signal !== undefined || context.adapter.detectReady(snapshot);

    if (!isReady) {
      return;
    }

    context.ready = true;
    context.currentRun = this.repository.markRunRunning({
      runId: context.run.runId,
      occurredAt: this.now(),
      payload: signal?.payload ?? {
        detection: "snapshot_probe",
      },
    });
    this.clearBootstrapTimer(context);
  }

  private async handleExit(
    context: LiveRunContext,
    event: SessionExit,
  ): Promise<void> {
    if (context.finishing) {
      return;
    }

    context.exit = event;
    await this.finishContext(context);
  }

  private async finishContext(context: LiveRunContext): Promise<void> {
    if (context.finishing || context.controller === null) {
      return;
    }

    context.finishing = true;
    this.clearTimers(context);
    this.flushHeartbeat(context, false);

    try {
      const sessionId = context.controller.sessionId;

      if (
        context.currentRun.status === "bootstrapping" &&
        context.exit?.exitCode === 0
      ) {
        context.currentRun = this.repository.markRunRunning({
          runId: context.run.runId,
          occurredAt: this.now(),
          payload: {
            detection: "synthetic_exit_before_ready",
          },
        });
      }

      const outcome =
        context.forcedOutcome ??
        (await context.adapter.collectOutcome(context.controller, context.exit));
      const resolvedOutcome = normalizeOutcome(outcome, context);

      this.liveRuns.removeByRunId(context.run.runId);
      await this.supervisor.terminate(sessionId, true);
      context.controller = null;
      await this.cleanupPreparedWorkspace(
        context,
        `Run reached terminal status '${resolvedOutcome.status}'.`,
      );

      context.currentRun = this.repository.finalizeRun({
        runId: context.run.runId,
        status: resolvedOutcome.status,
        occurredAt: context.exit?.occurredAt ?? this.now(),
        outcome: resolvedOutcome,
        payload: {
          sessionId,
          exitCode: context.exit?.exitCode ?? null,
          signal: context.exit?.signal ?? null,
        },
      });
      context.resolve(context.currentRun);
    } catch (error) {
      context.reject(error);
    } finally {
      this.activeContexts.delete(context.run.runId);
    }
  }

  private async failContext(
    context: LiveRunContext,
    error: Error,
  ): Promise<void> {
    const workspaceError =
      error instanceof WorkspacePreparationError ? error : null;
    const providerError =
      workspaceError?.providerError ??
      buildRuntimeProviderError({
        providerKind: context.run.provider,
        code: "unknown",
        message: error.message,
        retryable: false,
        details: {
          stage: "execution",
        },
      });

    context.forcedOutcome = {
      status: "failed",
      code: workspaceError?.outcomeCode ?? "runtime_execution_failed",
      summary: error.message,
      error: providerError,
    };

    if (
      !TERMINAL_STATUSES.has(context.currentRun.status) &&
      context.currentRun.status !== "failed"
    ) {
      context.currentRun = this.repository.recordRuntimeIssue({
        runId: context.run.runId,
        error: providerError,
        occurredAt: this.now(),
        source: workspaceError === null ? "provider" : "workspace",
        payload: workspaceError?.payload,
      });
    }

    if (context.controller !== null) {
      await context.controller.terminate(true);
      await this.finishContext(context);
      return;
    }

    context.finishing = true;
    this.clearTimers(context);

    try {
      await this.cleanupPreparedWorkspace(
        context,
        "Run failed before a provider session was established.",
      );
      context.currentRun = this.repository.finalizeRun({
        runId: context.run.runId,
        status: "failed",
        occurredAt: this.now(),
        outcome: context.forcedOutcome,
        payload: workspaceError?.payload,
      });
      context.resolve(context.currentRun);
    } catch (finalizeError) {
      context.reject(finalizeError);
    } finally {
      this.activeContexts.delete(context.run.runId);
    }
  }

  private async prepareWorkspace(context: LiveRunContext): Promise<void> {
    if (context.run.workspace.mode !== "ephemeral_worktree") {
      return;
    }

    const workingDir = resolveWorkspacePreparationDirectory(context.run);
    const allocationId = this.createWorkspaceAllocationId(context.run.runId);
    const occurredAt = this.now();
    const preparedWorkspace: PreparedWorkspaceState = {
      allocationId,
      mode: context.run.workspace.mode,
      workingDir,
      worktreeCreated: false,
      setupHookPath: null,
      cleanupComplete: false,
    };
    context.preparedWorkspace = preparedWorkspace;

    this.repository.createWorkspaceAllocation({
      workspaceAllocationId: allocationId,
      repoKey: context.run.repoRoot,
      repoRoot: context.run.repoRoot,
      mode: context.run.workspace.mode,
      workingDir,
      baseRef: context.run.workspace.baseRef ?? null,
      status: "preparing",
      claimedByRunId: context.run.runId,
      cleanupError: null,
    });
    context.currentRun = this.repository.bindWorkspaceAllocationToRun({
      runId: context.run.runId,
      workspaceAllocationId: allocationId,
      occurredAt,
      payload: {
        mode: context.run.workspace.mode,
        workingDir,
      },
    });
    this.refreshExecutableRun(context);

    this.appendWorkspaceEvent(context, {
      eventType: "workspace_preparation_started",
      payload: {
        allocationId,
        mode: context.run.workspace.mode,
        workingDir,
        baseRef: context.run.workspace.baseRef ?? null,
      },
    });

    try {
      if (this.workspaceOperations.exists(workingDir)) {
        throw this.createWorkspacePreparationError(context, {
          code: "conflict",
          message: `Workspace working directory '${workingDir}' already exists.`,
          stage: "preflight",
          payload: {
            allocationId,
            workingDir,
          },
        });
      }

      this.workspaceOperations.mkdir(path.dirname(workingDir));
      await this.workspaceOperations.runCommand({
        command: "git",
        args: [
          "-C",
          context.run.repoRoot,
          "worktree",
          "add",
          "--detach",
          workingDir,
          context.run.workspace.baseRef ?? "HEAD",
        ],
        cwd: context.run.repoRoot,
      });
      preparedWorkspace.worktreeCreated = true;

      const setupHookPath = resolveSetupHookPath(
        workingDir,
        this.workspaceOperations.exists,
      );
      preparedWorkspace.setupHookPath = setupHookPath;
      if (this.shouldAbortPrelaunch(context)) {
        return;
      }

      if (setupHookPath !== null) {
        this.appendWorkspaceEvent(context, {
          eventType: "workspace_setup_hook_started",
          payload: {
            allocationId,
            hookPath: setupHookPath,
          },
        });

        const result = await this.workspaceOperations.runCommand({
          command: "bash",
          args: [setupHookPath],
          cwd: workingDir,
          env: buildSetupHookEnvironment(context, workingDir),
          timeoutMs: context.run.limits.bootstrapTimeoutSec * 1_000,
        });

        this.appendWorkspaceEvent(context, {
          eventType: "workspace_setup_hook_completed",
          payload: {
            allocationId,
            hookPath: setupHookPath,
            stdout: summarizeCommandOutput(result.stdout),
            stderr: summarizeCommandOutput(result.stderr),
          },
        });
      }

      if (this.shouldAbortPrelaunch(context)) {
        return;
      }

      this.repository.updateWorkspaceAllocationStatus({
        workspaceAllocationId: allocationId,
        status: "ready",
        readyAt: this.now(),
        claimedByRunId: context.run.runId,
        cleanupError: null,
      });
      this.refreshExecutableRun(context);
      this.appendWorkspaceEvent(context, {
        eventType: "workspace_prepared",
        payload: {
          allocationId,
          workingDir,
          setupHookPath,
        },
      });
    } catch (error) {
      const workspaceError = toWorkspacePreparationError(context, error, {
        stage:
          error instanceof WorkspacePreparationError
            ? null
            : preparedWorkspace.worktreeCreated
              ? "workspace_setup"
              : "workspace_create",
        allocationId,
        workingDir,
        setupHookPath: preparedWorkspace.setupHookPath,
      });
      this.appendWorkspaceEvent(context, {
        eventType: "workspace_preparation_failed",
        level: "error",
        payload: {
          allocationId,
          workingDir,
          ...workspaceError.payload,
        },
      });
      await this.cleanupPreparedWorkspace(
        context,
        "Workspace preparation failed before provider launch.",
      );
      throw workspaceError;
    }
  }

  private async markWorkspaceInUse(context: LiveRunContext): Promise<void> {
    if (context.preparedWorkspace === null) {
      return;
    }

    this.repository.updateWorkspaceAllocationStatus({
      workspaceAllocationId: context.preparedWorkspace.allocationId,
      status: "in_use",
      claimedByRunId: context.run.runId,
      claimedAt: this.now(),
      cleanupError: null,
    });
    this.refreshExecutableRun(context);
    this.appendWorkspaceEvent(context, {
      eventType: "workspace_in_use",
      payload: {
        allocationId: context.preparedWorkspace.allocationId,
        workingDir: context.preparedWorkspace.workingDir,
      },
    });
  }

  private async cleanupPreparedWorkspace(
    context: LiveRunContext,
    reason: string,
  ): Promise<void> {
    const preparedWorkspace = context.preparedWorkspace;

    if (
      preparedWorkspace === null ||
      preparedWorkspace.mode !== "ephemeral_worktree" ||
      preparedWorkspace.cleanupComplete
    ) {
      return;
    }

    preparedWorkspace.cleanupComplete = true;
    this.appendWorkspaceEvent(context, {
      eventType: "workspace_release_started",
      payload: {
        allocationId: preparedWorkspace.allocationId,
        workingDir: preparedWorkspace.workingDir,
        reason,
      },
    });
    this.repository.updateWorkspaceAllocationStatus({
      workspaceAllocationId: preparedWorkspace.allocationId,
      status: "releasing",
      claimedByRunId: context.run.runId,
      cleanupError: null,
    });

    try {
      if (preparedWorkspace.worktreeCreated) {
        await this.workspaceOperations.runCommand({
          command: "git",
          args: [
            "-C",
            context.run.repoRoot,
            "worktree",
            "remove",
            "--force",
            preparedWorkspace.workingDir,
          ],
          cwd: context.run.repoRoot,
        });
      }

      this.repository.updateWorkspaceAllocationStatus({
        workspaceAllocationId: preparedWorkspace.allocationId,
        status: "released",
        claimedByRunId: null,
        releasedAt: this.now(),
        cleanupError: null,
      });
      this.appendWorkspaceEvent(context, {
        eventType: "workspace_released",
        payload: {
          allocationId: preparedWorkspace.allocationId,
          workingDir: preparedWorkspace.workingDir,
        },
      });
    } catch (error) {
      const cleanupMessage = error instanceof Error ? error.message : String(error);
      this.repository.updateWorkspaceAllocationStatus({
        workspaceAllocationId: preparedWorkspace.allocationId,
        status: "cleanup_failed",
        claimedByRunId: context.run.runId,
        cleanupError: cleanupMessage,
      });
      this.appendWorkspaceEvent(context, {
        eventType: "workspace_cleanup_failed",
        level: "warn",
        payload: {
          allocationId: preparedWorkspace.allocationId,
          workingDir: preparedWorkspace.workingDir,
          message: cleanupMessage,
        },
      });
    }
  }

  private refreshExecutableRun(context: LiveRunContext): void {
    const refreshedRun = this.repository.getExecutableRun(context.run.runId);
    if (refreshedRun !== null) {
      context.run = refreshedRun;
    }
    const refreshedCurrentRun = this.repository.getRun(context.run.runId);
    if (refreshedCurrentRun !== null) {
      context.currentRun = refreshedCurrentRun;
    }
  }

  private shouldAbortPrelaunch(context: LiveRunContext): boolean {
    return context.finishing || TERMINAL_STATUSES.has(context.currentRun.status);
  }

  private resolveFinishingPrelaunchContext(context: LiveRunContext): void {
    if (
      context.controller !== null ||
      !TERMINAL_STATUSES.has(context.currentRun.status) ||
      !this.activeContexts.has(context.run.runId)
    ) {
      return;
    }

    this.activeContexts.delete(context.run.runId);
    context.resolve(context.currentRun);
  }

  private appendWorkspaceEvent(
    context: LiveRunContext,
    input: {
      eventType: string;
      level?: "debug" | "info" | "warn" | "error";
      payload?: Record<string, unknown>;
      source?: RunEventSource;
    },
  ): void {
    this.repository.appendRunEvent({
      runId: context.run.runId,
      eventType: input.eventType,
      level: input.level ?? "info",
      source: input.source ?? "workspace",
      occurredAt: this.now(),
      payload: input.payload ?? {},
    });
  }

  private createWorkspacePreparationError(
    context: LiveRunContext,
    input: {
      code: ProviderError["code"];
      message: string;
      retryable?: boolean;
      stage: string;
      payload?: Record<string, unknown>;
    },
  ): WorkspacePreparationError {
    return new WorkspacePreparationError({
      message: input.message,
      providerError: buildRuntimeProviderError({
        providerKind: context.run.provider,
        code: input.code,
        message: input.message,
        retryable: input.retryable ?? false,
        details: {
          stage: input.stage,
        },
      }),
      payload: input.payload,
    });
  }

  private createSessionController(
    runId: string,
    sessionId: string,
    context: LiveRunContext,
  ): RuntimeSessionController {
    return {
      runId,
      sessionId,
      write: async (input) => {
        context.pendingHeartbeat.bytesWritten += Buffer.byteLength(input);
        await this.supervisor.write(sessionId, input);
      },
      interrupt: async () => {
        await this.supervisor.interrupt(sessionId);
      },
      terminate: async (force = false) => {
        await this.supervisor.terminate(sessionId, force);
      },
      snapshot: async () => this.supervisor.snapshot(sessionId),
      readRecentOutput: async (maxChars) =>
        this.supervisor.readRecentOutput(sessionId, maxChars),
    };
  }

  private startHeartbeatLoop(context: LiveRunContext): void {
    context.heartbeatTimer = this.setIntervalFn(() => {
      this.flushHeartbeat(context, true);
    }, this.heartbeatFlushIntervalMs);
  }

  private startBootstrapTimer(context: LiveRunContext): void {
    context.bootstrapTimer = this.setTimeoutFn(() => {
      if (context.finishing || context.controller === null || context.ready) {
        return;
      }

      context.forcedOutcome = {
        status: "failed",
        code: "provider_bootstrap_timeout",
        summary: "Provider bootstrap timed out before the session reported ready.",
        error: buildRuntimeProviderError({
          providerKind: context.run.provider,
          code: "timeout",
          message: "Provider bootstrap timed out before the session reported ready.",
          retryable: true,
          details: {
            bootstrapTimeoutSec: context.currentRun.limits.bootstrapTimeoutSec,
          },
        }),
      };
      void context.controller.terminate(true);
    }, context.currentRun.limits.bootstrapTimeoutSec * 1_000);
  }

  private scheduleCancelTermination(context: LiveRunContext): void {
    this.clearCancelTimer(context);
    context.cancelTimer = this.setTimeoutFn(() => {
      if (context.controller === null || context.finishing) {
        return;
      }

      void context.controller.terminate(true);
    }, this.cancelGracePeriodMs);
  }

  private flushHeartbeat(
    context: LiveRunContext,
    allowQuietTick: boolean,
  ): void {
    if (context.finishing || TERMINAL_STATUSES.has(context.currentRun.status)) {
      return;
    }

    const emittedAt = this.now();
    const { bytesRead, bytesWritten } = context.pendingHeartbeat;

    if (bytesRead > 0 || bytesWritten > 0) {
      this.repository.recordHeartbeat({
        runId: context.run.runId,
        emittedAt,
        source: bytesRead > 0 ? "pty_output" : "pty_input",
        bytesRead,
        bytesWritten,
        fileChanges: 0,
        providerState: context.currentRun.status,
        note: null,
      });
      context.pendingHeartbeat = { bytesRead: 0, bytesWritten: 0 };
      context.lastHeartbeatEmissionAt = Date.now();
      return;
    }

    if (
      allowQuietTick &&
      Date.now() - context.lastHeartbeatEmissionAt >=
        this.quietHeartbeatIntervalMs
    ) {
      this.repository.recordHeartbeat({
        runId: context.run.runId,
        emittedAt,
        source: "supervisor_tick",
        bytesRead: 0,
        bytesWritten: 0,
        fileChanges: 0,
        providerState: context.currentRun.status,
        note: "idle supervisor tick",
      });
      context.lastHeartbeatEmissionAt = Date.now();
    }
  }

  private clearTimers(context: LiveRunContext): void {
    if (context.heartbeatTimer !== null) {
      this.clearIntervalFn(context.heartbeatTimer);
      context.heartbeatTimer = null;
    }

    this.clearBootstrapTimer(context);
    this.clearCancelTimer(context);
  }

  private clearBootstrapTimer(context: LiveRunContext): void {
    if (context.bootstrapTimer !== null) {
      this.clearTimeoutFn(context.bootstrapTimer);
      context.bootstrapTimer = null;
    }
  }

  private clearCancelTimer(context: LiveRunContext): void {
    if (context.cancelTimer !== null) {
      this.clearTimeoutFn(context.cancelTimer);
      context.cancelTimer = null;
    }
  }

  private createLogFilePath(runId: string): string {
    const runDir = path.join(this.runtimeLogDir, runId);
    mkdirSync(runDir, { recursive: true });
    return path.join(runDir, "session.log");
  }

  private requireRun(runId: string): PersistedRunRecord {
    const run = this.repository.getRun(runId);

    if (run === null) {
      throw new RuntimeError(`Run '${runId}' was not found.`, {
        code: "run_not_found",
      });
    }

    return run;
  }
}

function resolveWorkingDirectory(run: ExecutableRunRecord): string {
  return run.workspace.workingDir ?? run.workspace.workingDirHint ?? run.repoRoot;
}

function resolveWorkspacePreparationDirectory(run: ExecutableRunRecord): string {
  const hint = run.workspace.workingDirHint;

  if (hint === null || hint === undefined || hint.length === 0) {
    return path.join(run.repoRoot, ".worktrees", run.runId);
  }

  return path.isAbsolute(hint) ? hint : path.resolve(run.repoRoot, hint);
}

function normalizeOutcome(
  outcome: RunOutcome,
  context: LiveRunContext,
): RunOutcome {
  if (context.cancelRequested === null) {
    return outcome;
  }

  return {
    ...outcome,
    status: "canceled",
    code: outcome.code ?? "canceled_by_request",
    summary: outcome.summary ?? context.cancelRequested.reason,
  };
}

function createDefaultWorkspaceOperations(): WorkspaceOperations {
  return {
    exists: (filePath) => existsSync(filePath),
    mkdir: (dirPath) => {
      mkdirSync(dirPath, { recursive: true });
    },
    removeDir: (dirPath) => {
      rmSync(dirPath, { recursive: true, force: true });
    },
    runCommand: async (input) => {
      try {
        const result = await execFileAsync(input.command, input.args, {
          cwd: input.cwd,
          env: input.env === undefined ? process.env : { ...process.env, ...input.env },
          timeout: input.timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        });

        return {
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
      } catch (error) {
        throw createWorkspaceCommandError(input, error);
      }
    },
  };
}

function buildSetupHookEnvironment(
  context: LiveRunContext,
  workingDir: string,
): Record<string, string> {
  return {
    ORQESTRATE_WORKSPACE_ROOT: workingDir,
    ORQESTRATE_REPO_ROOT: workingDir,
    ORQESTRATE_SOURCE_REPO_ROOT: context.run.repoRoot,
    ORQESTRATE_RUN_ID: context.run.runId,
    ORQESTRATE_PROVIDER: context.run.provider,
    ORQESTRATE_WORKSPACE_MODE: context.run.workspace.mode,
    ORQESTRATE_BASE_REF: context.run.workspace.baseRef ?? "",
    ORQESTRATE_ASSIGNED_BRANCH: context.run.workspace.assignedBranch ?? "",
  };
}

function resolveSetupHookPath(
  workingDir: string,
  exists: WorkspaceOperations["exists"],
): string | null {
  for (const candidate of SETUP_HOOK_CANDIDATES) {
    const candidatePath = path.join(workingDir, candidate);
    if (exists(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

function summarizeCommandOutput(output: string, maxChars = 4_000): string | null {
  const trimmed = output.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxChars)}...`;
}

function createWorkspaceCommandError(
  input: WorkspaceCommandInput,
  error: unknown,
): Error {
  if (error instanceof Error) {
    const details = error as Error & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | string;
      signal?: string;
      killed?: boolean;
    };

    const stdout = summarizeCommandOutput(String(details.stdout ?? ""));
    const stderr = summarizeCommandOutput(String(details.stderr ?? ""));
    const code = details.code ?? details.signal ?? "unknown";

    return new Error(
      [
        `Command '${input.command} ${input.args.join(" ")}' failed with '${code}'.`,
        stderr === null ? null : `stderr: ${stderr}`,
        stdout === null ? null : `stdout: ${stdout}`,
      ]
        .filter((value) => value !== null)
        .join(" "),
    );
  }

  return new Error(String(error));
}

function toWorkspacePreparationError(
  context: LiveRunContext,
  error: unknown,
  fallback: {
    stage: string | null;
    allocationId: string;
    workingDir: string;
    setupHookPath: string | null;
  },
): WorkspacePreparationError {
  if (error instanceof WorkspacePreparationError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const stage = fallback.stage ?? "workspace_prepare";
  return new WorkspacePreparationError({
    message,
    providerError: buildRuntimeProviderError({
      providerKind: context.run.provider,
      code: stage === "workspace_setup" ? "validation" : "unknown",
      message,
      retryable: false,
      details: {
        stage,
      },
    }),
    payload: {
      stage,
      allocationId: fallback.allocationId,
      workingDir: fallback.workingDir,
      hookPath: fallback.setupHookPath,
      message,
    },
  });
}
