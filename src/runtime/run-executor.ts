import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { RunStatus } from "../domain-model.js";
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
} from "./types.js";
import { RuntimeRepository } from "./persistence/runtime-repository.js";

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
};

type LiveRunContext = {
  run: ExecutableRunRecord;
  adapter: ProviderAdapter;
  controller: RuntimeSessionController | null;
  logFilePath: string;
  currentRun: PersistedRunRecord;
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
  }

  executeClaimedRun(run: ExecutableRunRecord): Promise<PersistedRunRecord> {
    return new Promise<PersistedRunRecord>((resolve, reject) => {
      const context: LiveRunContext = {
        run,
        adapter: this.adapterRegistry.create(run.provider),
        controller: null,
        logFilePath: this.createLogFilePath(run.runId),
        currentRun: run,
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
    const context = this.liveRuns.getByRunId(runId);
    const run = this.requireRun(runId);

    if (TERMINAL_STATUSES.has(run.status)) {
      return run;
    }

    if (context === null || context.controller === null) {
      return this.repository.cancelRunBeforeLaunch({
        runId,
        occurredAt: this.now(),
        reason,
        requestedBy: requestedBy ?? null,
      });
    }

    context.cancelRequested = { reason, requestedBy };
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
      return;
    }

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

      context.currentRun = this.repository.finalizeRun({
        runId: context.run.runId,
        status: resolvedOutcome.status,
        occurredAt: context.exit?.occurredAt ?? this.now(),
        outcome: resolvedOutcome,
        payload: {
          sessionId: context.controller.sessionId,
          exitCode: context.exit?.exitCode ?? null,
          signal: context.exit?.signal ?? null,
        },
      });

      this.liveRuns.removeByRunId(context.run.runId);
      await this.supervisor.terminate(context.controller.sessionId, true);
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
    const providerError = buildRuntimeProviderError({
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
      code: "runtime_execution_failed",
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
      });
    }

    if (context.controller !== null) {
      await context.controller.terminate(true);
    }

    await this.finishContext(context);
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
