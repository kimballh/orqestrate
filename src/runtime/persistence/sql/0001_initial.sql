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
