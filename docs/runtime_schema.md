# Runtime Schema

This file freezes the first persistence schema and TypeScript contracts for the agent runtime service.

## 1. Storage decision

Use SQLite in WAL mode for v1.

Why:

- host-local daemon
- strong enough durability for one machine
- simple backups and inspection
- no separate infrastructure dependency

Recommended state root:

- macOS/Linux: `$XDG_STATE_HOME/linear-codex-runtime` or `~/.local/state/linear-codex-runtime`
- Windows: `%LOCALAPPDATA%/linear-codex-runtime`

Recommended files:

- `runtime.sqlite`
- `logs/`
- `sockets/` or platform-specific pipe registration

## 2. Canonical tables

The first schema should include:

- `runs`
- `run_events`
- `session_heartbeats`
- `workspace_allocations`

Do not add more tables until the first runtime loop exists.

## 3. `runs`

The `runs` table is the canonical current-state record for each submitted run.

The persistence schema should materialize the canonical `RunRecord` and `RunSubmissionPayload` from `src/domain-model.ts`. Column names may stay storage-oriented, but the TypeScript surface above the database should match the shared contract.

Suggested SQLite DDL:

```sql
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  work_item_identifier TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('design', 'plan', 'implement', 'review', 'merge')),
  provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
  status TEXT NOT NULL CHECK (
    status IN (
      'queued',
      'admitted',
      'launching',
      'bootstrapping',
      'running',
      'waiting_human',
      'stopping',
      'completed',
      'failed',
      'canceled',
      'stale'
    )
  ),
  priority INTEGER NOT NULL DEFAULT 100,
  repo_root TEXT NOT NULL,
  working_dir_hint TEXT,
  workspace_mode TEXT NOT NULL CHECK (workspace_mode IN ('shared_readonly', 'ephemeral_worktree')),
  workspace_allocation_id TEXT,
  base_ref TEXT,
  prompt_contract TEXT NOT NULL,
  prompt_envelope_json TEXT,
  system_prompt_hash TEXT,
  user_prompt_hash TEXT NOT NULL,
  artifact_url TEXT,
  requested_by TEXT,
  runtime_owner TEXT,
  max_wall_time_sec INTEGER NOT NULL,
  idle_timeout_sec INTEGER NOT NULL,
  bootstrap_timeout_sec INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  waiting_human_reason TEXT,
  outcome_code TEXT,
  exit_code INTEGER,
  summary TEXT,
  verification_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  admitted_at TEXT,
  started_at TEXT,
  ready_at TEXT,
  completed_at TEXT,
  last_heartbeat_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (workspace_allocation_id) REFERENCES workspace_allocations(workspace_allocation_id)
);

CREATE INDEX runs_status_priority_idx ON runs(status, priority, created_at);
CREATE INDEX runs_work_item_idx ON runs(work_item_id, phase, status);
CREATE INDEX runs_provider_status_idx ON runs(provider, status, created_at);
CREATE INDEX runs_repo_status_idx ON runs(repo_root, status, created_at);
```

Column rules:

- `run_id` is supplied by the orchestrator and doubles as the idempotency key
- `status` is authoritative runtime state
- `prompt_envelope_json` persists the launchable prompt payload so the runtime can actually start a queued run without depending on another store for the prompt body
- `summary`, `outcome_code`, and `last_error` are write-on-transition fields, not free-form logs
- `version` exists for optimistic updates if you need them later

## 4. `run_events`

The `run_events` table is append-only.

Suggested SQLite DDL:

```sql
CREATE TABLE run_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  source TEXT NOT NULL CHECK (source IN ('api', 'scheduler', 'workspace', 'supervisor', 'provider')),
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);

CREATE INDEX run_events_run_seq_idx ON run_events(run_id, seq);
CREATE INDEX run_events_type_idx ON run_events(event_type, occurred_at);
```

Rules:

- never update an event row after insert
- event payload stays compact JSON, not terminal dumps
- event `seq` is the stream cursor

## 5. `session_heartbeats`

The `session_heartbeats` table captures liveness evidence.

Suggested SQLite DDL:

```sql
CREATE TABLE session_heartbeats (
  heartbeat_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  emitted_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (
    source IN ('pty_output', 'pty_input', 'workspace', 'adapter_probe', 'supervisor_tick')
  ),
  bytes_read INTEGER NOT NULL DEFAULT 0,
  bytes_written INTEGER NOT NULL DEFAULT 0,
  file_changes INTEGER NOT NULL DEFAULT 0,
  provider_state TEXT,
  note TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);

CREATE INDEX heartbeats_run_time_idx ON session_heartbeats(run_id, emitted_at DESC);
```

Rules:

- update `runs.last_heartbeat_at` on every heartbeat insert
- keep heartbeat rows small
- use `run_events` for semantic milestones and `session_heartbeats` for liveness

## 6. `workspace_allocations`

The `workspace_allocations` table tracks prepared workspaces separately from run state.

Suggested SQLite DDL:

```sql
CREATE TABLE workspace_allocations (
  workspace_allocation_id TEXT PRIMARY KEY,
  repo_key TEXT NOT NULL,
  repo_root TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('shared_readonly', 'ephemeral_worktree')),
  working_dir TEXT NOT NULL UNIQUE,
  branch_name TEXT,
  base_ref TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('preparing', 'ready', 'in_use', 'releasing', 'released', 'dirty', 'cleanup_failed')
  ),
  claimed_by_run_id TEXT,
  created_at TEXT NOT NULL,
  ready_at TEXT,
  claimed_at TEXT,
  released_at TEXT,
  lease_until TEXT,
  cleanup_error TEXT,
  FOREIGN KEY (claimed_by_run_id) REFERENCES runs(run_id)
);

CREATE INDEX workspaces_repo_status_idx ON workspace_allocations(repo_key, status, created_at);
CREATE INDEX workspaces_claim_idx ON workspace_allocations(claimed_by_run_id);
```

Rules:

- `repo_key` is a stable hash or normalized key for the repository root
- `working_dir` is unique across live allocations
- `shared_readonly` allocations may be reused
- `ephemeral_worktree` allocations should be one-run-per-allocation

## 7. TypeScript enums

```ts
import type {
  AgentProvider,
  RunStatus,
  WorkPhase,
  WorkspaceMode,
} from "../src/domain-model.js";

export type WorkspaceAllocationStatus =
  | "preparing"
  | "ready"
  | "in_use"
  | "releasing"
  | "released"
  | "dirty"
  | "cleanup_failed";

export type RunEventLevel = "debug" | "info" | "warn" | "error";

export type RunEventSource =
  | "api"
  | "scheduler"
  | "workspace"
  | "supervisor"
  | "provider";
```

## 8. TypeScript records

```ts
import type {
  PromptAttachment,
  RunRecord,
  RunSubmissionPayload,
} from "../src/domain-model.js";

export type PersistedRunRecord = RunRecord & {
  priority: number;
  runtimeOwner?: string | null;
  attemptCount: number;
  waitingHumanReason?: string | null;
  readyAt?: string | null;
  version: number;
};

export type CreateRunInput = RunSubmissionPayload & {
  priority?: number;
};

export type RunEventRecord = {
  seq: number;
  runId: string;
  eventType: string;
  level: RunEventLevel;
  source: RunEventSource;
  occurredAt: string;
  payload: Record<string, unknown>;
};

export type SessionHeartbeatRecord = {
  heartbeatId: number;
  runId: string;
  emittedAt: string;
  source: "pty_output" | "pty_input" | "workspace" | "adapter_probe" | "supervisor_tick";
  bytesRead: number;
  bytesWritten: number;
  fileChanges: number;
  providerState?: string | null;
  note?: string | null;
};

export type WorkspaceAllocationRecord = {
  workspaceAllocationId: string;
  repoKey: string;
  repoRoot: string;
  mode: WorkspaceMode;
  workingDir: string;
  branchName?: string | null;
  baseRef?: string | null;
  status: WorkspaceAllocationStatus;
  claimedByRunId?: string | null;
  createdAt: string;
  readyAt?: string | null;
  claimedAt?: string | null;
  releasedAt?: string | null;
  leaseUntil?: string | null;
  cleanupError?: string | null;
};
```

## 9. Runtime issues

The provider adapter should emit normalized runtime issues.

```ts
export type RuntimeIssueCode =
  | "provider_not_installed"
  | "provider_bad_launch_args"
  | "provider_bootstrap_timeout"
  | "provider_not_ready"
  | "provider_waiting_human"
  | "provider_permission_prompt"
  | "provider_git_conflict"
  | "provider_idle_timeout"
  | "provider_wall_time_exceeded"
  | "provider_nonzero_exit"
  | "transport_broken"
  | "workspace_prepare_failed"
  | "workspace_dirty_on_release";

export type RuntimeIssue = {
  code: RuntimeIssueCode;
  severity: "info" | "warn" | "error";
  retryable: boolean;
  humanActionRequired: boolean;
  summary: string;
  providerEvidence?: string | null;
};
```

These should be persisted as `runtime_issue_detected` events and optionally reflected into `runs.last_error` or `runs.waiting_human_reason`.

## 10. Provider adapter contract

This is the first TypeScript interface to freeze.

```ts
export type RunLaunchInput = {
  run: PersistedRunRecord;
  workspace: WorkspaceAllocationRecord;
  userPrompt: string;
  systemPrompt?: string | null;
  attachments?: PromptAttachment[];
};

export type LaunchSpec = {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
};

export type SessionSnapshot = {
  runId: string;
  status: RunStatus;
  recentOutput: string;
  lastHeartbeatAt?: string | null;
  bytesRead: number;
  bytesWritten: number;
};

export type OutputEvent = {
  stream: "stdout" | "stderr";
  chunk: string;
  occurredAt: string;
};

export type RuntimeSignal =
  | { kind: "ready" }
  | { kind: "progress"; summary?: string }
  | { kind: "waiting_human"; reason: string }
  | { kind: "issue"; issue: RuntimeIssue }
  | { kind: "completed_hint"; summary?: string };

export type HumanInput = {
  kind: "answer" | "approval" | "clarification";
  message: string;
  author?: string | null;
};

export type RunOutcome = {
  finalStatus: "completed" | "failed" | "canceled" | "stale";
  outcomeCode?: string | null;
  summary?: string | null;
  verification?: Record<string, unknown> | null;
  issue?: RuntimeIssue | null;
  exitCode?: number | null;
};

export type ProviderAdapter = {
  kind: AgentProvider;
  buildLaunchSpec(input: RunLaunchInput): LaunchSpec;
  detectReady(snapshot: SessionSnapshot): boolean;
  classifyOutput(event: OutputEvent): RuntimeSignal[];
  submitInitialPrompt(sessionId: string, prompt: string): Promise<void>;
  submitHumanInput(sessionId: string, input: HumanInput): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  collectOutcome(sessionId: string): Promise<RunOutcome>;
};
```

Rules:

- adapters do not mutate database state directly
- adapters return normalized signals and outcomes
- adapters do not own queueing, workspace prep, or concurrency

## 11. Session supervisor contract

The provider adapter should sit on top of a PTY supervisor interface.

```ts
export type LiveSessionHandle = {
  sessionId: string;
  pid: number;
  runId: string;
};

export type SessionSupervisor = {
  launch(spec: LaunchSpec): Promise<LiveSessionHandle>;
  write(sessionId: string, input: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  terminate(sessionId: string, force?: boolean): Promise<void>;
  readRecentOutput(sessionId: string, maxChars: number): Promise<string>;
  isAlive(sessionId: string): Promise<boolean>;
  attachHeartbeat(runId: string, sessionId: string): Promise<void>;
};
```

This is where PTY choice lives. Keep it below the provider adapter.

## 12. Persistence rules

Keep these invariants:

- `runs` is current state
- `run_events` is append-only history
- `session_heartbeats` is liveness evidence
- `workspace_allocations` is workspace state, not run state

And:

- never infer `completed` from event absence
- never infer liveness from process existence alone
- never use tmux panes as authoritative session ids

## 13. Retention policy

First-pass retention:

- keep all `runs`
- keep all `run_events`
- prune `session_heartbeats` older than `14-30 days`
- keep released `workspace_allocations` until cleanup plus audit window completes

If SQLite size becomes a problem later, archive `run_events` and `session_heartbeats` before redesigning the schema.
