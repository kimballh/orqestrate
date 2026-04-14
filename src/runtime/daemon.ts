import { mkdirSync } from "node:fs";

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
  PersistedRunRecord,
  RecordHeartbeatInput,
  RunEventRecord,
  SessionHeartbeatRecord,
  UpdateWorkspaceAllocationStatusInput,
  WorkspaceAllocationRecord,
} from "./types.js";

type RuntimeDaemonDependencies = {
  adapterRegistry?: RuntimeAdapterRegistry;
  sessionSupervisor?: SessionSupervisor;
  runExecutor?: RunExecutor;
};

export class RuntimeDaemon {
  #database: RuntimeDatabase | null = null;
  #repository: RuntimeRepository | null = null;
  #executor: RunExecutor | null = null;
  readonly adapterRegistry: RuntimeAdapterRegistry;
  readonly sessionSupervisor: SessionSupervisor;

  constructor(
    readonly runtimeConfig: RuntimeConfig,
    dependencies: RuntimeDaemonDependencies = {},
  ) {
    this.adapterRegistry =
      dependencies.adapterRegistry ?? new RuntimeAdapterRegistry();
    this.sessionSupervisor =
      dependencies.sessionSupervisor ?? new NodePtySessionSupervisor();
    this.#executor = dependencies.runExecutor ?? null;
  }

  static fromLoadedConfig(loadedConfig: LoadedConfig): RuntimeDaemon {
    return new RuntimeDaemon(resolveRuntimeConfig(loadedConfig));
  }

  get isStarted(): boolean {
    return this.#repository !== null;
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
  }

  stop(): void {
    if (this.#database === null) {
      return;
    }

    this.#database.close();
    this.#database = null;
    this.#repository = null;
    this.#executor = null;
  }

  enqueueRun(input: CreateRunInput): PersistedRunRecord {
    return this.repository.enqueueRun(input);
  }

  getRun(runId: string): PersistedRunRecord | null {
    return this.repository.getRun(runId);
  }

  listRuns(filters: ListRunsFilters = {}): PersistedRunRecord[] {
    return this.repository.listRuns(filters);
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

    return this.executor.executeClaimedRun(claimedRun);
  }

  interruptRun(runId: string): Promise<PersistedRunRecord> {
    return this.executor.interruptRun(runId);
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
}
