import { mkdirSync } from "node:fs";

import type { LoadedConfig } from "../config/types.js";
import { RuntimeError } from "./errors.js";
import { openRuntimeDatabase, type RuntimeDatabase } from "./persistence/database.js";
import { RuntimeRepository } from "./persistence/runtime-repository.js";
import { resolveRuntimeConfig, type RuntimeConfig } from "./config.js";
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

export class RuntimeDaemon {
  #database: RuntimeDatabase | null = null;
  #repository: RuntimeRepository | null = null;

  constructor(readonly runtimeConfig: RuntimeConfig) {}

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

  start(): void {
    if (this.#repository !== null) {
      return;
    }

    mkdirSync(this.runtimeConfig.stateDir, { recursive: true });
    mkdirSync(this.runtimeConfig.logDir, { recursive: true });
    mkdirSync(this.runtimeConfig.runtimeLogDir, { recursive: true });

    this.#database = openRuntimeDatabase(this.runtimeConfig.databasePath);
    this.#repository = new RuntimeRepository(this.#database.connection);
  }

  stop(): void {
    if (this.#database === null) {
      return;
    }

    this.#database.close();
    this.#database = null;
    this.#repository = null;
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
