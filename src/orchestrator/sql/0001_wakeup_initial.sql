CREATE TABLE wakeup_events (
  event_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  action TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'processing', 'done', 'dead_letter')
  ),
  attempts INTEGER NOT NULL DEFAULT 0,
  first_received_at TEXT NOT NULL,
  last_received_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  claimed_at TEXT,
  processed_at TEXT,
  processor_owner TEXT,
  coalesced_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  payload_json TEXT
);

CREATE UNIQUE INDEX wakeup_events_live_queue_idx
  ON wakeup_events(dedupe_key)
  WHERE status = 'queued';

CREATE INDEX wakeup_events_status_time_idx
  ON wakeup_events(status, available_at, last_received_at, event_id);

CREATE INDEX wakeup_events_issue_idx
  ON wakeup_events(issue_id, status, last_received_at);
