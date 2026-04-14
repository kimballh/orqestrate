import type BetterSqlite3 from "better-sqlite3";

import type {
  AgentProvider,
  PromptEnvelope,
  ProviderError,
  RunStatus,
  VerificationSummary,
} from "../../domain-model.js";
import { RuntimeError } from "../errors.js";
import type {
  AppendRunEventInput,
  CreateRunInput,
  CreateWorkspaceAllocationInput,
  ExecutableRunRecord,
  ListRunEventsOptions,
  ListRunsFilters,
  PersistedRunRecord,
  RecordHeartbeatInput,
  RunEventRecord,
  RunTerminalStatus,
  RuntimeOutcomeSnapshot,
  SessionHeartbeatRecord,
  UpdateWorkspaceAllocationStatusInput,
  WorkspaceAllocationRecord,
  WorkspaceAllocationStatus,
} from "../types.js";

type RunRow = {
  run_id: string;
  work_item_id: string;
  work_item_identifier: string | null;
  phase: PersistedRunRecord["phase"];
  provider: PersistedRunRecord["provider"];
  status: PersistedRunRecord["status"];
  priority: number;
  repo_root: string;
  working_dir_hint: string | null;
  workspace_mode: PersistedRunRecord["workspace"]["mode"];
  workspace_allocation_id: string | null;
  base_ref: string | null;
  prompt_contract: string;
  prompt_envelope_json: string | null;
  system_prompt_hash: string | null;
  user_prompt_hash: string;
  artifact_url: string | null;
  requested_by: string | null;
  runtime_owner: string | null;
  max_wall_time_sec: number;
  idle_timeout_sec: number;
  bootstrap_timeout_sec: number;
  attempt_count: number;
  waiting_human_reason: string | null;
  outcome_code: string | null;
  exit_code: number | null;
  summary: string | null;
  verification_json: string | null;
  last_error: string | null;
  created_at: string;
  admitted_at: string | null;
  started_at: string | null;
  ready_at: string | null;
  completed_at: string | null;
  last_heartbeat_at: string | null;
  version: number;
  workspace_working_dir: string | null;
  workspace_branch_name: string | null;
};

type RunEventRow = {
  seq: number;
  run_id: string;
  event_type: string;
  level: RunEventRecord["level"];
  source: RunEventRecord["source"];
  occurred_at: string;
  payload_json: string;
};

type HeartbeatRow = {
  heartbeat_id: number;
  run_id: string;
  emitted_at: string;
  source: SessionHeartbeatRecord["source"];
  bytes_read: number;
  bytes_written: number;
  file_changes: number;
  provider_state: string | null;
  note: string | null;
};

type WorkspaceAllocationRow = {
  workspace_allocation_id: string;
  repo_key: string;
  repo_root: string;
  mode: WorkspaceAllocationRecord["mode"];
  working_dir: string;
  branch_name: string | null;
  base_ref: string | null;
  status: WorkspaceAllocationStatus;
  claimed_by_run_id: string | null;
  created_at: string;
  ready_at: string | null;
  claimed_at: string | null;
  released_at: string | null;
  lease_until: string | null;
  cleanup_error: string | null;
};

type RunMutationEvent = {
  eventType: string;
  level?: RunEventRecord["level"];
  source?: RunEventRecord["source"];
  payload?: Record<string, unknown>;
};

const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_EVENT_LIMIT = 100;
const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "canceled",
  "stale",
]);
const NON_TERMINAL_RUN_STATUSES: RunStatus[] = [
  "queued",
  "admitted",
  "launching",
  "bootstrapping",
  "running",
  "waiting_human",
  "stopping",
];
const ACTIVE_SESSION_RUN_STATUSES: RunStatus[] = [
  "admitted",
  "launching",
  "bootstrapping",
  "running",
  "waiting_human",
  "stopping",
];

const RUN_SELECT_SQL = `
  SELECT
    runs.*,
    workspace_allocations.working_dir AS workspace_working_dir,
    workspace_allocations.branch_name AS workspace_branch_name
  FROM runs
  LEFT JOIN workspace_allocations
    ON workspace_allocations.workspace_allocation_id = runs.workspace_allocation_id
`;

export class RuntimeRepository {
  constructor(private readonly database: BetterSqlite3.Database) {}

  enqueueRun(input: CreateRunInput): PersistedRunRecord {
    const insertRun = this.database.transaction(
      (createRunInput: CreateRunInput): PersistedRunRecord => {
        const existing = this.selectRunById(createRunInput.runId);

        if (existing !== null) {
          return this.mapRunRow(existing);
        }

        const createdAt = new Date().toISOString();
        const priority = createRunInput.priority ?? 100;

        this.database
          .prepare(
            `
              INSERT INTO runs (
                run_id,
                work_item_id,
                work_item_identifier,
                phase,
                provider,
                status,
                priority,
                repo_root,
                working_dir_hint,
                workspace_mode,
                workspace_allocation_id,
                base_ref,
                prompt_contract,
                prompt_envelope_json,
                system_prompt_hash,
                user_prompt_hash,
                artifact_url,
                requested_by,
                runtime_owner,
                max_wall_time_sec,
                idle_timeout_sec,
                bootstrap_timeout_sec,
                attempt_count,
                waiting_human_reason,
                outcome_code,
                exit_code,
                summary,
                verification_json,
                last_error,
                created_at,
                admitted_at,
                started_at,
                ready_at,
                completed_at,
                last_heartbeat_at,
                version
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            createRunInput.runId,
            createRunInput.workItem.id,
            createRunInput.workItem.identifier ?? null,
            createRunInput.phase,
            createRunInput.provider,
            "queued",
            priority,
            createRunInput.workspace.repoRoot,
            createRunInput.workspace.workingDirHint ?? null,
            createRunInput.workspace.mode,
            null,
            createRunInput.workspace.baseRef ?? null,
            createRunInput.prompt.contractId,
            encodeJson(createRunInput.prompt),
            createRunInput.prompt.digests.system ?? null,
            createRunInput.prompt.digests.user,
            createRunInput.artifact?.url ?? null,
            createRunInput.requestedBy ?? null,
            null,
            createRunInput.limits.maxWallTimeSec,
            createRunInput.limits.idleTimeoutSec,
            createRunInput.limits.bootstrapTimeoutSec,
            0,
            null,
            null,
            null,
            null,
            null,
            null,
            createdAt,
            null,
            null,
            null,
            null,
            null,
            1,
          );

        this.database
          .prepare(
            `
              INSERT INTO run_events (
                run_id,
                event_type,
                level,
                source,
                occurred_at,
                payload_json
              )
              VALUES (?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            createRunInput.runId,
            "run_enqueued",
            "info",
            "api",
            createdAt,
            encodeJson({
              phase: createRunInput.phase,
              provider: createRunInput.provider,
              status: "queued",
            }),
          );

        return this.getRunOrThrow(createRunInput.runId);
      },
    );

    return insertRun(input);
  }

  getRun(runId: string): PersistedRunRecord | null {
    const row = this.selectRunById(runId);
    return row === null ? null : this.mapRunRow(row);
  }

  getExecutableRun(runId: string): ExecutableRunRecord | null {
    const row = this.selectRunById(runId);
    return row === null ? null : this.mapExecutableRunRow(row);
  }

  listRuns(filters: ListRunsFilters = {}): PersistedRunRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.status !== undefined) {
      clauses.push("runs.status = ?");
      params.push(filters.status);
    }

    if (filters.provider !== undefined) {
      clauses.push("runs.provider = ?");
      params.push(filters.provider);
    }

    if (filters.workItemId !== undefined) {
      clauses.push("runs.work_item_id = ?");
      params.push(filters.workItemId);
    }

    if (filters.phase !== undefined) {
      clauses.push("runs.phase = ?");
      params.push(filters.phase);
    }

    if (filters.repoRoot !== undefined) {
      clauses.push("runs.repo_root = ?");
      params.push(filters.repoRoot);
    }

    let sql = RUN_SELECT_SQL;

    if (clauses.length > 0) {
      sql += ` WHERE ${clauses.join(" AND ")}`;
    }

    sql += " ORDER BY runs.created_at DESC LIMIT ?";
    params.push(clampLimit(filters.limit, DEFAULT_LIST_LIMIT));

    const rows = this.database.prepare(sql).all(...params) as RunRow[];
    return rows.map((row) => this.mapRunRow(row));
  }

  claimNextQueuedRun(input: {
    runtimeOwner: string;
    provider?: AgentProvider;
    occurredAt?: string;
  }): ExecutableRunRecord | null {
    const claimRun = this.database.transaction((): ExecutableRunRecord | null => {
      const clauses = ["status = 'queued'"];
      const params: unknown[] = [];

      if (input.provider !== undefined) {
        clauses.push("provider = ?");
        params.push(input.provider);
      }

      const nextRow = this.database
        .prepare(
          `
            ${RUN_SELECT_SQL}
            WHERE ${clauses.map((clause) => `runs.${clause}`).join(" AND ")}
            ORDER BY runs.priority ASC, runs.created_at ASC
            LIMIT 1
          `,
        )
        .get(...params) as RunRow | undefined;

      if (nextRow === undefined) {
        return null;
      }

      const occurredAt = input.occurredAt ?? new Date().toISOString();
      const nextRun = this.buildNextRunState(this.mapRunRow(nextRow), {
        status: "admitted",
        runtimeOwner: input.runtimeOwner,
        admittedAt: occurredAt,
        attemptCount: nextRow.attempt_count + 1,
      });

      this.persistRun(nextRun);
      this.insertRunEvent(nextRun.runId, occurredAt, {
        eventType: "run_admitted",
        payload: {
          runtimeOwner: input.runtimeOwner,
          status: "admitted",
        },
      });

      return this.getExecutableRunOrThrow(nextRun.runId);
    });

    return claimRun();
  }

  markRunLaunching(input: {
    runId: string;
    occurredAt?: string;
    payload?: Record<string, unknown>;
  }): PersistedRunRecord {
    return this.transitionRunState({
      runId: input.runId,
      from: ["admitted"],
      occurredAt: input.occurredAt,
      nextState: {
        status: "launching",
      },
      event: {
        eventType: "session_launch_requested",
        payload: input.payload,
      },
    });
  }

  markRunBootstrapping(input: {
    runId: string;
    occurredAt?: string;
    payload?: Record<string, unknown>;
  }): PersistedRunRecord {
    const occurredAt = input.occurredAt ?? new Date().toISOString();

    return this.transitionRunState({
      runId: input.runId,
      from: ["launching"],
      occurredAt,
      nextState: {
        status: "bootstrapping",
        startedAt: occurredAt,
      },
      event: {
        eventType: "session_started",
        payload: input.payload,
      },
    });
  }

  markRunRunning(input: {
    runId: string;
    occurredAt?: string;
    payload?: Record<string, unknown>;
  }): PersistedRunRecord {
    const occurredAt = input.occurredAt ?? new Date().toISOString();

    return this.transitionRunState({
      runId: input.runId,
      from: ["bootstrapping", "waiting_human"],
      occurredAt,
      nextState: {
        status: "running",
        waitingHumanReason: null,
        readyAt: occurredAt,
      },
      event: {
        eventType: "session_ready",
        payload: input.payload,
      },
    });
  }

  markRunWaitingHuman(input: {
    runId: string;
    reason: string;
    occurredAt?: string;
    payload?: Record<string, unknown>;
  }): PersistedRunRecord {
    return this.transitionRunState({
      runId: input.runId,
      from: ["bootstrapping", "running"],
      occurredAt: input.occurredAt,
      nextState: {
        status: "waiting_human",
        waitingHumanReason: input.reason,
      },
      event: {
        eventType: "waiting_human",
        payload: {
          ...(input.payload ?? {}),
          reason: input.reason,
        },
      },
    });
  }

  resumeRunFromWaitingHuman(input: {
    runId: string;
    occurredAt?: string;
    payload?: Record<string, unknown>;
  }): PersistedRunRecord {
    return this.transitionRunState({
      runId: input.runId,
      from: ["waiting_human"],
      occurredAt: input.occurredAt,
      nextState: {
        status: "running",
        waitingHumanReason: null,
      },
      event: {
        eventType: "human_input_received",
        payload: input.payload,
      },
    });
  }

  markRunStopping(input: {
    runId: string;
    occurredAt?: string;
    payload?: Record<string, unknown>;
  }): PersistedRunRecord {
    return this.transitionRunState({
      runId: input.runId,
      from: ["launching", "bootstrapping", "running", "waiting_human"],
      occurredAt: input.occurredAt,
      nextState: {
        status: "stopping",
      },
      event: {
        eventType: "cancel_requested",
        payload: input.payload,
      },
    });
  }

  recordRuntimeIssue(input: {
    runId: string;
    error: ProviderError;
    occurredAt?: string;
    payload?: Record<string, unknown>;
  }): PersistedRunRecord {
    const occurredAt = input.occurredAt ?? new Date().toISOString();

    return this.mutateRun({
      runId: input.runId,
      allowedStatuses: NON_TERMINAL_RUN_STATUSES,
      occurredAt,
      mutate: (current) => ({
        ...current,
        outcome: mergeOutcome(current.outcome, {
          error: input.error,
        }),
      }),
      event: {
        eventType: "runtime_issue_detected",
        source: "provider",
        level: "warn",
        payload: {
          ...(input.payload ?? {}),
          code: input.error.code,
          message: input.error.message,
          retryable: input.error.retryable,
        },
      },
    });
  }

  finalizeRun(input: {
    runId: string;
    status: RunTerminalStatus;
    outcome?: RuntimeOutcomeSnapshot | null;
    occurredAt?: string;
    payload?: Record<string, unknown>;
  }): PersistedRunRecord {
    const occurredAt = input.occurredAt ?? new Date().toISOString();

    return this.mutateRun({
      runId: input.runId,
      allowedStatuses: ["launching", "bootstrapping", "running", "waiting_human", "stopping"],
      occurredAt,
      mutate: (current) => ({
        ...current,
        status: input.status,
        completedAt: occurredAt,
        waitingHumanReason: null,
        outcome: mergeOutcome(current.outcome, input.outcome ?? null),
      }),
      event: {
        eventType: terminalEventType(input.status),
        payload: {
          ...(input.payload ?? {}),
          status: input.status,
        },
      },
    });
  }

  cancelRunBeforeLaunch(input: {
    runId: string;
    reason: string;
    requestedBy?: string | null;
    occurredAt?: string;
  }): PersistedRunRecord {
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const cancelRun = this.database.transaction(
      (transactionInput: typeof input): PersistedRunRecord => {
        const current = this.getRunOrThrow(transactionInput.runId);

        if (!["queued", "admitted"].includes(current.status)) {
          throw new RuntimeError(
            `Run '${transactionInput.runId}' cannot be canceled before launch from '${current.status}'.`,
            {
              code: "invalid_run_state_transition",
            },
          );
        }

        const next = this.buildNextRunState(current, {
          status: "canceled",
          completedAt: occurredAt,
          waitingHumanReason: null,
          outcome: mergeOutcome(current.outcome, {
            code: "canceled_before_launch",
            summary: transactionInput.reason,
          }),
        });

        this.persistRun(next);
        this.insertRunEvent(next.runId, occurredAt, {
          eventType: "cancel_requested",
          source: "api",
          payload: {
            reason: transactionInput.reason,
            requestedBy: transactionInput.requestedBy ?? null,
          },
        });
        this.insertRunEvent(next.runId, occurredAt, {
          eventType: "run_canceled",
          payload: {
            status: "canceled",
            reason: transactionInput.reason,
          },
        });

        return this.getRunOrThrow(next.runId);
      },
    );

    return cancelRun(input);
  }

  markRunStaleOnRecovery(input: {
    runId: string;
    reason: string;
    occurredAt?: string;
  }): PersistedRunRecord {
    const occurredAt = input.occurredAt ?? new Date().toISOString();

    return this.mutateRun({
      runId: input.runId,
      allowedStatuses: NON_TERMINAL_RUN_STATUSES,
      occurredAt,
      mutate: (current) => ({
        ...current,
        status: "stale",
        completedAt: occurredAt,
        waitingHumanReason: null,
        outcome: mergeOutcome(current.outcome, {
          summary: current.outcome?.summary ?? input.reason,
          error: current.outcome?.error ?? {
            providerFamily: "runtime",
            providerKind: current.provider,
            code: "unavailable",
            message: input.reason,
            retryable: true,
            details: { staleOnRecovery: true },
          },
        }),
      }),
      event: {
        eventType: "run_stale",
        level: "warn",
        payload: {
          reason: input.reason,
        },
      },
    });
  }

  markAllNonTerminalRunsStaleOnRecovery(input: {
    occurredAt?: string;
  } = {}): PersistedRunRecord[] {
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const rows = this.database
      .prepare(
        `
          ${RUN_SELECT_SQL}
          WHERE runs.status IN (${ACTIVE_SESSION_RUN_STATUSES.map(() => "?").join(", ")})
          ORDER BY runs.created_at ASC
        `,
      )
      .all(...ACTIVE_SESSION_RUN_STATUSES) as RunRow[];

    return rows.map((row) =>
      this.markRunStaleOnRecovery({
        runId: row.run_id,
        occurredAt,
        reason: "Runtime restarted without rehydrating the live PTY session.",
      }),
    );
  }

  appendRunEvent(input: AppendRunEventInput): RunEventRecord {
    this.assertRunExists(input.runId);

    const result = this.database
      .prepare(
        `
          INSERT INTO run_events (
            run_id,
            event_type,
            level,
            source,
            occurred_at,
            payload_json
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        input.runId,
        input.eventType,
        input.level,
        input.source,
        input.occurredAt,
        encodeJson(input.payload),
      );

    return {
      ...input,
      seq: Number(result.lastInsertRowid),
    };
  }

  listRunEvents(
    runId: string,
    options: ListRunEventsOptions = {},
  ): RunEventRecord[] {
    const clauses = ["run_id = ?"];
    const params: unknown[] = [runId];

    if (options.afterSeq !== undefined) {
      clauses.push("seq > ?");
      params.push(options.afterSeq);
    }

    params.push(clampLimit(options.limit, DEFAULT_EVENT_LIMIT));

    const rows = this.database
      .prepare(
        `
          SELECT *
          FROM run_events
          WHERE ${clauses.join(" AND ")}
          ORDER BY seq ASC
          LIMIT ?
        `,
      )
      .all(...params) as RunEventRow[];

    return rows.map((row) => this.mapRunEventRow(row));
  }

  recordHeartbeat(input: RecordHeartbeatInput): SessionHeartbeatRecord {
    this.assertRunExists(input.runId);

    const writeHeartbeat = this.database.transaction(
      (heartbeatInput: RecordHeartbeatInput): SessionHeartbeatRecord => {
        const result = this.database
          .prepare(
            `
              INSERT INTO session_heartbeats (
                run_id,
                emitted_at,
                source,
                bytes_read,
                bytes_written,
                file_changes,
                provider_state,
                note
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            heartbeatInput.runId,
            heartbeatInput.emittedAt,
            heartbeatInput.source,
            heartbeatInput.bytesRead,
            heartbeatInput.bytesWritten,
            heartbeatInput.fileChanges,
            heartbeatInput.providerState ?? null,
            heartbeatInput.note ?? null,
          );

        this.database
          .prepare(
            `
              UPDATE runs
              SET last_heartbeat_at = CASE
                WHEN last_heartbeat_at IS NULL OR last_heartbeat_at < ?
                  THEN ?
                ELSE last_heartbeat_at
              END
              WHERE run_id = ?
            `,
          )
          .run(
            heartbeatInput.emittedAt,
            heartbeatInput.emittedAt,
            heartbeatInput.runId,
          );

        return {
          ...heartbeatInput,
          heartbeatId: Number(result.lastInsertRowid),
        };
      },
    );

    return writeHeartbeat(input);
  }

  createWorkspaceAllocation(
    input: CreateWorkspaceAllocationInput,
  ): WorkspaceAllocationRecord {
    const createdAt = input.createdAt ?? new Date().toISOString();

    this.database
      .prepare(
        `
          INSERT INTO workspace_allocations (
            workspace_allocation_id,
            repo_key,
            repo_root,
            mode,
            working_dir,
            branch_name,
            base_ref,
            status,
            claimed_by_run_id,
            created_at,
            ready_at,
            claimed_at,
            released_at,
            lease_until,
            cleanup_error
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        input.workspaceAllocationId,
        input.repoKey,
        input.repoRoot,
        input.mode,
        input.workingDir,
        input.branchName ?? null,
        input.baseRef ?? null,
        input.status ?? "preparing",
        input.claimedByRunId ?? null,
        createdAt,
        input.readyAt ?? null,
        input.claimedAt ?? null,
        input.releasedAt ?? null,
        input.leaseUntil ?? null,
        input.cleanupError ?? null,
      );

    return this.getWorkspaceAllocationOrThrow(input.workspaceAllocationId);
  }

  getWorkspaceAllocation(
    workspaceAllocationId: string,
  ): WorkspaceAllocationRecord | null {
    const row = this.database
      .prepare(
        `
          SELECT *
          FROM workspace_allocations
          WHERE workspace_allocation_id = ?
        `,
      )
      .get(workspaceAllocationId) as WorkspaceAllocationRow | undefined;

    return row === undefined ? null : this.mapWorkspaceAllocationRow(row);
  }

  updateWorkspaceAllocationStatus(
    input: UpdateWorkspaceAllocationStatusInput,
  ): WorkspaceAllocationRecord {
    const current = this.getWorkspaceAllocation(input.workspaceAllocationId);

    if (current === null) {
      throw new RuntimeError(
        `Workspace allocation '${input.workspaceAllocationId}' was not found.`,
        {
          code: "workspace_allocation_not_found",
        },
      );
    }

    const nextRecord: WorkspaceAllocationRecord = {
      ...current,
      status: input.status,
      branchName:
        "branchName" in input ? input.branchName ?? null : current.branchName,
      baseRef: "baseRef" in input ? input.baseRef ?? null : current.baseRef,
      claimedByRunId:
        "claimedByRunId" in input
          ? input.claimedByRunId ?? null
          : current.claimedByRunId,
      readyAt: "readyAt" in input ? input.readyAt ?? null : current.readyAt,
      claimedAt:
        "claimedAt" in input ? input.claimedAt ?? null : current.claimedAt,
      releasedAt:
        "releasedAt" in input ? input.releasedAt ?? null : current.releasedAt,
      leaseUntil:
        "leaseUntil" in input ? input.leaseUntil ?? null : current.leaseUntil,
      cleanupError:
        "cleanupError" in input
          ? input.cleanupError ?? null
          : current.cleanupError,
    };

    this.database
      .prepare(
        `
          UPDATE workspace_allocations
          SET
            branch_name = ?,
            base_ref = ?,
            status = ?,
            claimed_by_run_id = ?,
            ready_at = ?,
            claimed_at = ?,
            released_at = ?,
            lease_until = ?,
            cleanup_error = ?
          WHERE workspace_allocation_id = ?
        `,
      )
      .run(
        nextRecord.branchName ?? null,
        nextRecord.baseRef ?? null,
        nextRecord.status,
        nextRecord.claimedByRunId ?? null,
        nextRecord.readyAt ?? null,
        nextRecord.claimedAt ?? null,
        nextRecord.releasedAt ?? null,
        nextRecord.leaseUntil ?? null,
        nextRecord.cleanupError ?? null,
        input.workspaceAllocationId,
      );

    return this.getWorkspaceAllocationOrThrow(input.workspaceAllocationId);
  }

  private transitionRunState(input: {
    runId: string;
    from: RunStatus[];
    occurredAt?: string;
    nextState: Partial<PersistedRunRecord>;
    event: RunMutationEvent;
  }): PersistedRunRecord {
    const occurredAt = input.occurredAt ?? new Date().toISOString();

    return this.mutateRun({
      runId: input.runId,
      allowedStatuses: input.from,
      occurredAt,
      mutate: (current) => ({
        ...current,
        ...input.nextState,
      }),
      event: input.event,
    });
  }

  private mutateRun(input: {
    runId: string;
    allowedStatuses: RunStatus[];
    occurredAt: string;
    mutate: (current: PersistedRunRecord) => PersistedRunRecord;
    event: RunMutationEvent;
  }): PersistedRunRecord {
    const applyMutation = this.database.transaction(
      (
        transactionInput: typeof input,
      ): PersistedRunRecord => {
        const current = this.getRunOrThrow(transactionInput.runId);

        if (!transactionInput.allowedStatuses.includes(current.status)) {
          throw new RuntimeError(
            `Run '${transactionInput.runId}' cannot transition from '${current.status}'.`,
            {
              code: "invalid_run_state_transition",
            },
          );
        }

        const next = this.buildNextRunState(
          transactionInput.mutate(current),
          {},
        );
        this.persistRun(next);
        this.insertRunEvent(next.runId, transactionInput.occurredAt, transactionInput.event);
        return this.getRunOrThrow(next.runId);
      },
    );

    return applyMutation(input);
  }

  private insertRunEvent(
    runId: string,
    occurredAt: string,
    event: RunMutationEvent,
  ): void {
    this.database
      .prepare(
        `
          INSERT INTO run_events (
            run_id,
            event_type,
            level,
            source,
            occurred_at,
            payload_json
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        runId,
        event.eventType,
        event.level ?? "info",
        event.source ?? "supervisor",
        occurredAt,
        encodeJson(event.payload ?? {}),
      );
  }

  private persistRun(run: PersistedRunRecord): void {
    this.database
      .prepare(
        `
          UPDATE runs
          SET
            status = ?,
            workspace_allocation_id = ?,
            runtime_owner = ?,
            attempt_count = ?,
            waiting_human_reason = ?,
            outcome_code = ?,
            exit_code = ?,
            summary = ?,
            verification_json = ?,
            last_error = ?,
            admitted_at = ?,
            started_at = ?,
            ready_at = ?,
            completed_at = ?,
            version = ?
          WHERE run_id = ?
        `,
      )
      .run(
        run.status,
        run.workspace.allocationId ?? null,
        run.runtimeOwner ?? null,
        run.attemptCount,
        run.waitingHumanReason ?? null,
        run.outcome?.code ?? null,
        run.outcome?.exitCode ?? null,
        run.outcome?.summary ?? null,
        encodeNullableJson(run.outcome?.verification ?? null),
        encodeNullableJson(run.outcome?.error ?? null),
        run.admittedAt ?? null,
        run.startedAt ?? null,
        run.readyAt ?? null,
        run.completedAt ?? null,
        run.version,
        run.runId,
      );
  }

  private buildNextRunState(
    run: PersistedRunRecord,
    overrides: Partial<PersistedRunRecord>,
  ): PersistedRunRecord {
    return {
      ...run,
      ...overrides,
      version: (overrides.version ?? run.version) + 1,
    };
  }

  private assertRunExists(runId: string): void {
    const row = this.database
      .prepare("SELECT 1 FROM runs WHERE run_id = ?")
      .get(runId) as { 1: number } | undefined;

    if (row === undefined) {
      throw new RuntimeError(`Run '${runId}' was not found.`, {
        code: "run_not_found",
      });
    }
  }

  private getRunOrThrow(runId: string): PersistedRunRecord {
    const run = this.getRun(runId);

    if (run === null) {
      throw new RuntimeError(`Run '${runId}' was not found.`, {
        code: "run_not_found",
      });
    }

    return run;
  }

  private getExecutableRunOrThrow(runId: string): ExecutableRunRecord {
    const run = this.getExecutableRun(runId);

    if (run === null) {
      throw new RuntimeError(`Run '${runId}' was not found.`, {
        code: "run_not_found",
      });
    }

    return run;
  }

  private getWorkspaceAllocationOrThrow(
    workspaceAllocationId: string,
  ): WorkspaceAllocationRecord {
    const allocation = this.getWorkspaceAllocation(workspaceAllocationId);

    if (allocation === null) {
      throw new RuntimeError(
        `Workspace allocation '${workspaceAllocationId}' was not found.`,
        {
          code: "workspace_allocation_not_found",
        },
      );
    }

    return allocation;
  }

  private selectRunById(runId: string): RunRow | null {
    const row = this.database
      .prepare(`${RUN_SELECT_SQL} WHERE runs.run_id = ?`)
      .get(runId) as RunRow | undefined;

    return row ?? null;
  }

  private mapRunRow(row: RunRow): PersistedRunRecord {
    const verification = parseJson<VerificationSummary>(row.verification_json);
    const error = parseJson<ProviderError>(row.last_error);
    const hasOutcome =
      row.outcome_code !== null ||
      row.exit_code !== null ||
      row.summary !== null ||
      verification !== null ||
      error !== null;

    return {
      runId: row.run_id,
      workItemId: row.work_item_id,
      workItemIdentifier: row.work_item_identifier,
      phase: row.phase,
      provider: row.provider,
      status: row.status,
      priority: row.priority,
      repoRoot: row.repo_root,
      workspace: {
        mode: row.workspace_mode,
        workingDirHint: row.working_dir_hint,
        workingDir: row.workspace_working_dir,
        allocationId: row.workspace_allocation_id,
        baseRef: row.base_ref,
        branchName: row.workspace_branch_name,
      },
      artifactUrl: row.artifact_url,
      requestedBy: row.requested_by,
      promptContractId: row.prompt_contract,
      promptDigests: {
        system: row.system_prompt_hash,
        user: row.user_prompt_hash,
      },
      limits: {
        maxWallTimeSec: row.max_wall_time_sec,
        idleTimeoutSec: row.idle_timeout_sec,
        bootstrapTimeoutSec: row.bootstrap_timeout_sec,
      },
      outcome: hasOutcome
        ? {
            code: row.outcome_code,
            exitCode: row.exit_code,
            summary: row.summary,
            verification,
            error,
          }
        : null,
      runtimeOwner: row.runtime_owner,
      attemptCount: row.attempt_count,
      waitingHumanReason: row.waiting_human_reason,
      createdAt: row.created_at,
      admittedAt: row.admitted_at,
      startedAt: row.started_at,
      readyAt: row.ready_at,
      completedAt: row.completed_at,
      lastHeartbeatAt: row.last_heartbeat_at,
      version: row.version,
    };
  }

  private mapExecutableRunRow(row: RunRow): ExecutableRunRecord {
    const prompt = parseJson<PromptEnvelope>(row.prompt_envelope_json);

    if (
      prompt === null ||
      typeof prompt.contractId !== "string" ||
      typeof prompt.userPrompt !== "string"
    ) {
      throw new RuntimeError(
        `Run '${row.run_id}' is missing its persisted prompt envelope.`,
        {
          code: "run_prompt_missing",
        },
      );
    }

    return {
      ...this.mapRunRow(row),
      prompt,
    };
  }

  private mapRunEventRow(row: RunEventRow): RunEventRecord {
    return {
      seq: row.seq,
      runId: row.run_id,
      eventType: row.event_type,
      level: row.level,
      source: row.source,
      occurredAt: row.occurred_at,
      payload: parseJson<Record<string, unknown>>(row.payload_json) ?? {},
    };
  }

  private mapWorkspaceAllocationRow(
    row: WorkspaceAllocationRow,
  ): WorkspaceAllocationRecord {
    return {
      workspaceAllocationId: row.workspace_allocation_id,
      repoKey: row.repo_key,
      repoRoot: row.repo_root,
      mode: row.mode,
      workingDir: row.working_dir,
      branchName: row.branch_name,
      baseRef: row.base_ref,
      status: row.status,
      claimedByRunId: row.claimed_by_run_id,
      createdAt: row.created_at,
      readyAt: row.ready_at,
      claimedAt: row.claimed_at,
      releasedAt: row.released_at,
      leaseUntil: row.lease_until,
      cleanupError: row.cleanup_error,
    };
  }
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  return Math.max(1, value);
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

function encodeNullableJson(value: unknown | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

function parseJson<T>(value: string | null): T | null {
  if (value === null) {
    return null;
  }

  return JSON.parse(value) as T;
}

function mergeOutcome(
  current: PersistedRunRecord["outcome"],
  next: RuntimeOutcomeSnapshot | null,
): PersistedRunRecord["outcome"] {
  if (current === null && next === null) {
    return null;
  }

  return {
    code: next?.code ?? current?.code ?? null,
    exitCode: next?.exitCode ?? current?.exitCode ?? null,
    summary: next?.summary ?? current?.summary ?? null,
    verification: next?.verification ?? current?.verification ?? null,
    error: next?.error ?? current?.error ?? null,
  };
}

function terminalEventType(status: RunTerminalStatus): string {
  switch (status) {
    case "completed":
      return "run_completed";
    case "failed":
      return "run_failed";
    case "canceled":
      return "run_canceled";
    case "stale":
      return "run_stale";
  }
}
