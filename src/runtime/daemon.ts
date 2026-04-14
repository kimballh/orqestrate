import { mkdirSync } from "node:fs";

import { AGENT_PROVIDERS, type AgentProvider } from "../domain-model.js";
import type { LoadedConfig } from "../config/types.js";
import { RuntimeError } from "./errors.js";
import { openRuntimeDatabase, type RuntimeDatabase } from "./persistence/database.js";
import { RuntimeRepository } from "./persistence/runtime-repository.js";
import { resolveRuntimeConfig, type RuntimeConfig } from "./config.js";
import type { HumanInput, ProviderAdapterFactory } from "./provider-adapter.js";
import { RunExecutor } from "./run-executor.js";
import { RuntimeAdapterRegistry } from "./runtime-adapter-registry.js";
import type { SessionSupervisor } from "./session-supervisor.js";
import { NodePtySessionSupervisor } from "./supervisor/node-pty-session-supervisor.js";
import type {
  AppendRunEventInput,
  CreateRunInput,
  CreateWorkspaceAllocationInput,
  ListRunEventsOptions,
  ListRunsFilters,
  ListRunsPage,
  PersistedRunRecord,
  RecordHeartbeatInput,
  RunEventRecord,
  RuntimeCapacitySnapshot,
  RuntimeProviderCapacitySnapshot,
  RuntimeReadinessSnapshot,
  SessionHeartbeatRecord,
  UpdateWorkspaceAllocationStatusInput,
  WorkspaceAllocationRecord,
} from "./types.js";

type RuntimeDaemonDependencies = {
  adapterRegistry?: RuntimeAdapterRegistry;
  sessionSupervisor?: SessionSupervisor;
  runExecutor?: RunExecutor;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  dispatcherIntervalMs?: number;
};

const ACTIVE_RUN_STATUSES = new Set<PersistedRunRecord["status"]>([
  "admitted",
  "launching",
  "bootstrapping",
  "running",
  "waiting_human",
  "stopping",
]);

export class RuntimeDaemon {
  #database: RuntimeDatabase | null = null;
  #repository: RuntimeRepository | null = null;
  #executor: RunExecutor | null = null;
  #dispatcherTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  #drainPromise: Promise<void> | null = null;
  #drainRequested = false;
  readonly adapterRegistry: RuntimeAdapterRegistry;
  readonly sessionSupervisor: SessionSupervisor;
  readonly #setInterval: typeof globalThis.setInterval;
  readonly #clearInterval: typeof globalThis.clearInterval;
  readonly #dispatcherIntervalMs: number;

  constructor(
    readonly runtimeConfig: RuntimeConfig,
    dependencies: RuntimeDaemonDependencies = {},
  ) {
    this.adapterRegistry =
      dependencies.adapterRegistry ?? new RuntimeAdapterRegistry();
    this.sessionSupervisor =
      dependencies.sessionSupervisor ?? new NodePtySessionSupervisor();
    this.#executor = dependencies.runExecutor ?? null;
    this.#setInterval = dependencies.setInterval ?? globalThis.setInterval;
    this.#clearInterval = dependencies.clearInterval ?? globalThis.clearInterval;
    this.#dispatcherIntervalMs = dependencies.dispatcherIntervalMs ?? 1_000;
  }

  static fromLoadedConfig(loadedConfig: LoadedConfig): RuntimeDaemon {
    return new RuntimeDaemon(resolveRuntimeConfig(loadedConfig));
  }

  get isStarted(): boolean {
    return this.#repository !== null;
  }

  get isDispatcherRunning(): boolean {
    return this.#dispatcherTimer !== null;
  }

  get repository(): RuntimeRepository {
    if (this.#repository === null) {
      throw new RuntimeError("Runtime daemon has not been started.", {
        code: "runtime_not_started",
      });
    }

    return this.#repository;
  }

  get executor(): RunExecutor {
    if (this.#executor === null) {
      throw new RuntimeError("Runtime daemon has not been started.", {
        code: "runtime_not_started",
      });
    }

    return this.#executor;
  }

  start(): void {
    if (this.#repository !== null) {
      return;
    }

    mkdirSync(this.runtimeConfig.stateDir, { recursive: true });
    mkdirSync(this.runtimeConfig.logDir, { recursive: true });
    mkdirSync(this.runtimeConfig.runtimeLogDir, { recursive: true });

    this.#database = openRuntimeDatabase(this.runtimeConfig.databasePath);
    this.#repository = new RuntimeRepository(this.#database.connection);
    this.#repository.markAllNonTerminalRunsStaleOnRecovery();
    this.#executor ??= new RunExecutor(
      this.#repository,
      this.adapterRegistry,
      this.sessionSupervisor,
      this.runtimeConfig.runtimeLogDir,
    );
    this.#dispatcherTimer = this.#setInterval(() => {
      this.requestDispatch();
    }, this.#dispatcherIntervalMs);
    this.requestDispatch();
  }

  stop(): void {
    if (this.#dispatcherTimer !== null) {
      this.#clearInterval(this.#dispatcherTimer);
      this.#dispatcherTimer = null;
    }

    if (this.#database === null) {
      return;
    }

    this.#database.close();
    this.#database = null;
    this.#repository = null;
    this.#executor = null;
    this.#drainPromise = null;
    this.#drainRequested = false;
  }

  enqueueRun(input: CreateRunInput): PersistedRunRecord {
    const run = this.repository.enqueueRun(input);
    this.requestDispatch();
    return run;
  }

  getRun(runId: string): PersistedRunRecord | null {
    return this.repository.getRun(runId);
  }

  getRunLastEventSeq(runId: string): number | null {
    return this.repository.getLatestRunEventSeq(runId);
  }

  listRuns(filters: ListRunsFilters = {}): PersistedRunRecord[] {
    return this.repository.listRuns(filters);
  }

  listRunsPage(filters: ListRunsFilters = {}): ListRunsPage {
    return this.repository.listRunsPage(filters);
  }

  appendRunEvent(input: AppendRunEventInput): RunEventRecord {
    return this.repository.appendRunEvent(input);
  }

  listRunEvents(
    runId: string,
    options: ListRunEventsOptions = {},
  ): RunEventRecord[] {
    return this.repository.listRunEvents(runId, options);
  }

  recordHeartbeat(input: RecordHeartbeatInput): SessionHeartbeatRecord {
    return this.repository.recordHeartbeat(input);
  }

  registerRuntimeAdapter(
    kind: CreateRunInput["provider"],
    create: ProviderAdapterFactory,
  ): RuntimeDaemon {
    this.adapterRegistry.register(kind, create);
    this.requestDispatch();
    return this;
  }

  runNextQueued(input: {
    runtimeOwner: string;
    provider?: CreateRunInput["provider"];
  }): Promise<PersistedRunRecord | null> {
    const claimedRun = this.repository.claimNextQueuedRun({
      runtimeOwner: input.runtimeOwner,
      provider: input.provider,
    });

    if (claimedRun === null) {
      return Promise.resolve(null);
    }

    return this.trackExecution(claimedRun);
  }

  interruptRun(runId: string): Promise<PersistedRunRecord> {
    return this.executor.interruptRun(runId);
  }

  canInterruptRun(runId: string): boolean {
    return this.executor.hasLiveSession(runId);
  }

  cancelRun(
    runId: string,
    reason: string,
    requestedBy?: string | null,
  ): Promise<PersistedRunRecord> {
    return this.executor.cancelRun(runId, reason, requestedBy);
  }

  submitHumanInput(
    runId: string,
    input: HumanInput,
  ): Promise<PersistedRunRecord> {
    return this.executor.submitHumanInput(runId, input);
  }

  getCapacitySnapshot(): RuntimeCapacitySnapshot {
    const activeRuns = this.repository.listActiveRuns();
    const queuedRuns = this.repository.listQueuedRunsForDispatch();
    const providers = Object.fromEntries(
      AGENT_PROVIDERS.map((provider) => [
        provider,
        {
          provider,
          max: this.runtimeConfig.policy.maxRunsPerProvider,
          active: 0,
          queued: 0,
          available: this.runtimeConfig.policy.maxRunsPerProvider,
        } satisfies RuntimeProviderCapacitySnapshot,
      ]),
    ) as RuntimeCapacitySnapshot["providers"];
    const repoCounts = new Map<
      string,
      {
        active: number;
        queued: number;
      }
    >();

    for (const run of activeRuns) {
      providers[run.provider].active += 1;
      providers[run.provider].available = Math.max(
        0,
        providers[run.provider].max - providers[run.provider].active,
      );
      const repo = repoCounts.get(run.repoRoot) ?? { active: 0, queued: 0 };
      repo.active += 1;
      repoCounts.set(run.repoRoot, repo);
    }

    for (const run of queuedRuns) {
      providers[run.provider].queued += 1;
      const repo = repoCounts.get(run.repoRoot) ?? { active: 0, queued: 0 };
      repo.queued += 1;
      repoCounts.set(run.repoRoot, repo);
    }

    return {
      global: {
        max: this.runtimeConfig.policy.maxConcurrentRuns,
        active: activeRuns.length,
        queued: queuedRuns.length,
        available: Math.max(
          0,
          this.runtimeConfig.policy.maxConcurrentRuns - activeRuns.length,
        ),
      },
      providers,
      repos: [...repoCounts.entries()]
        .map(([repoRoot, counts]) => ({
          repoRoot,
          active: counts.active,
          queued: counts.queued,
        }))
        .sort((left, right) => left.repoRoot.localeCompare(right.repoRoot)),
      mixedProvidersAllowed: this.runtimeConfig.policy.allowMixedProviders,
    };
  }

  getReadinessSnapshot(input: {
    transportReady: boolean;
  }): RuntimeReadinessSnapshot {
    const providers = this.adapterRegistry.listProviders();
    const checks = {
      database: { ok: this.#repository !== null },
      dispatcher: { ok: this.#dispatcherTimer !== null },
      transport: { ok: input.transportReady },
      adapters: {
        ok: providers.length > 0,
        providers,
      },
    };

    return {
      ok:
        checks.database.ok &&
        checks.dispatcher.ok &&
        checks.transport.ok &&
        checks.adapters.ok,
      profile: this.runtimeConfig.profileName,
      checks,
    };
  }

  createWorkspaceAllocation(
    input: CreateWorkspaceAllocationInput,
  ): WorkspaceAllocationRecord {
    return this.repository.createWorkspaceAllocation(input);
  }

  getWorkspaceAllocation(
    workspaceAllocationId: string,
  ): WorkspaceAllocationRecord | null {
    return this.repository.getWorkspaceAllocation(workspaceAllocationId);
  }

  updateWorkspaceAllocationStatus(
    input: UpdateWorkspaceAllocationStatusInput,
  ): WorkspaceAllocationRecord {
    return this.repository.updateWorkspaceAllocationStatus(input);
  }

  private requestDispatch(): void {
    if (!this.isStarted) {
      return;
    }

    this.#drainRequested = true;

    if (this.#drainPromise !== null) {
      return;
    }

    this.#drainPromise = this.drainQueue().finally(() => {
      this.#drainPromise = null;

      if (this.#drainRequested) {
        this.requestDispatch();
      }
    });
  }

  private async drainQueue(): Promise<void> {
    while (this.#drainRequested && this.isStarted) {
      this.#drainRequested = false;

      while (this.isStarted) {
        const candidate = this.selectDispatchCandidate();

        if (candidate === null) {
          break;
        }

        const claimedRun = this.repository.claimQueuedRun({
          runId: candidate.runId,
          runtimeOwner: this.buildRuntimeOwner(),
        });

        if (claimedRun === null) {
          continue;
        }

        void this.trackExecution(claimedRun);
      }
    }
  }

  private selectDispatchCandidate(): PersistedRunRecord | null {
    const queuedRuns = this.repository.listQueuedRunsForDispatch();
    const activeRuns = this.repository.listActiveRuns();
    const registeredProviders = new Set(this.adapterRegistry.listProviders());

    if (
      activeRuns.length >= this.runtimeConfig.policy.maxConcurrentRuns ||
      queuedRuns.length === 0
    ) {
      return null;
    }

    const activeProviderCounts = new Map<AgentProvider, number>();
    const activeProviders = new Set<AgentProvider>();
    const activeWorkItems = new Set<string>();

    for (const run of activeRuns) {
      activeProviderCounts.set(
        run.provider,
        (activeProviderCounts.get(run.provider) ?? 0) + 1,
      );
      activeProviders.add(run.provider);
      activeWorkItems.add(run.workItemId);
    }

    for (const run of queuedRuns) {
      if (registeredProviders.has(run.provider) === false) {
        continue;
      }

      if (activeWorkItems.has(run.workItemId)) {
        continue;
      }

      if (
        (activeProviderCounts.get(run.provider) ?? 0) >=
        this.runtimeConfig.policy.maxRunsPerProvider
      ) {
        continue;
      }

      if (
        this.runtimeConfig.policy.allowMixedProviders === false &&
        activeProviders.size > 0 &&
        activeProviders.has(run.provider) === false
      ) {
        continue;
      }

      return run;
    }

    return null;
  }

  private async trackExecution(
    claimedRun: PersistedRunRecord & { runId: string },
  ): Promise<PersistedRunRecord> {
    try {
      return await this.executor.executeClaimedRun(claimedRun as never);
    } finally {
      this.requestDispatch();
    }
  }

  private buildRuntimeOwner(): string {
    return `runtime-daemon:${this.runtimeConfig.profileName}`;
  }
}
