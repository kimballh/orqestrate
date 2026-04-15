# Operator Runbook

This guide covers the practical runtime and orchestrator troubleshooting surfaces that exist in the repo today.

Use it when you need to:

- start or restart the runtime daemon
- inspect health, capacity, or run state
- respond to `waiting_human` runs
- cancel or interrupt a run
- diagnose common local runtime failures

For deeper rationale and contract details, see:

- [runtime_api.md](./runtime_api.md)
- [agent_runtime.md](./agent_runtime.md)
- [orchestrator.md](./orchestrator.md)

## Runtime Entry Points

Start the local runtime daemon:

```bash
npm run dev
```

Start the built daemon:

```bash
npm start
```

The daemon:

- reads `config.toml`
- creates the configured state and log directories if they do not exist
- opens the runtime SQLite database
- starts the dispatcher loop
- binds the local API transport

## Default Local Paths

With the shipped local config:

- state dir: `./.harness/state`
- data dir: `./.harness/data`
- log dir: `./.harness/logs`
- runtime log dir: `./.harness/logs/runtime`
- runtime database: `./.harness/state/runtime.sqlite`

Transport path:

- macOS/Linux: `./.harness/state/sockets/runtime.sock`
- Windows: `\\.\pipe\orqestrate-runtime-<active-profile>`

If your `config.toml` changes those paths, the config wins.

## Health And Capacity Checks

On macOS or Linux:

```bash
ORQ_SOCKET="$PWD/.harness/state/sockets/runtime.sock"
curl --unix-socket "$ORQ_SOCKET" http://runtime.local/v1/health
curl --unix-socket "$ORQ_SOCKET" http://runtime.local/v1/capacity
```

`GET /v1/health` reports:

- overall `ok`
- the active profile
- database, dispatcher, transport, and adapter readiness checks

`GET /v1/capacity` reports:

- global concurrency
- provider-specific concurrency
- per-repo active and queued counts
- whether mixed providers are allowed

If the daemon process is up but the socket is missing, restart the daemon and check the configured state directory first.

## Inspecting Runs

Preferred operator workflow:

```bash
npx tsx src/index.ts run list
npx tsx src/index.ts run inspect <run-id>
```

Focused diagnostics views:

```bash
npx tsx src/index.ts run inspect <run-id> --view timeline
npx tsx src/index.ts run inspect <run-id> --view prompt
npx tsx src/index.ts run inspect <run-id> --view failure
```

Machine-readable output:

```bash
npx tsx src/index.ts run inspect <run-id> --format json
```

The CLI uses the public runtime API under the hood, so the `curl` examples below remain the low-level fallback when you need raw responses or API debugging.

List runs:

```bash
curl --unix-socket "$ORQ_SOCKET" \
  "http://runtime.local/v1/runs?limit=20"
```

Filter by status:

```bash
curl --unix-socket "$ORQ_SOCKET" \
  "http://runtime.local/v1/runs?status=running&limit=20"
```

Get one run:

```bash
RUN_ID="replace-me"
curl --unix-socket "$ORQ_SOCKET" \
  "http://runtime.local/v1/runs/$RUN_ID"
```

Fetch append-only events:

```bash
curl --unix-socket "$ORQ_SOCKET" \
  "http://runtime.local/v1/runs/$RUN_ID/events?after=0&limit=200&waitMs=0"
```

Stream live events:

```bash
curl --no-buffer --unix-socket "$ORQ_SOCKET" \
  "http://runtime.local/v1/runs/$RUN_ID/stream"
```

## Run Status Interpretation

Important runtime statuses:

- `queued`: waiting for admission
- `admitted`: slot and workspace reserved
- `launching`: provider process launch has started
- `bootstrapping`: process exists but is not trusted as ready yet
- `running`: provider is active
- `waiting_human`: provider is blocked on a human answer or approval
- `stopping`: cancellation is in progress
- `completed`, `failed`, `canceled`, `stale`: terminal

Important distinction:

- `stale` means the runtime lost confidence in liveness or ownership
- `waiting_human` means the run is live, but it cannot continue without operator input

The daemon marks non-terminal runs as `stale` on recovery after restart. Treat those runs as needing reconciliation, not as still running.

## Responding To A Waiting Run

Send human input:

```bash
curl --unix-socket "$ORQ_SOCKET" \
  -X POST \
  -H "content-type: application/json" \
  -d '{
    "kind": "answer",
    "message": "Use the existing shared API adapter instead of adding a new one.",
    "author": "operator"
  }' \
  "http://runtime.local/v1/runs/$RUN_ID/actions/human-input"
```

Expected outcome:

- the runtime records the input
- the run transitions from `waiting_human` back to `running` if delivery succeeds

If the delivery fails, the run remains `waiting_human`. Inspect the latest events before retrying.

## Interrupting Or Canceling A Run

Soft interrupt:

```bash
curl --unix-socket "$ORQ_SOCKET" \
  -X POST \
  "http://runtime.local/v1/runs/$RUN_ID/actions/interrupt"
```

Cancel:

```bash
curl --unix-socket "$ORQ_SOCKET" \
  -X POST \
  -H "content-type: application/json" \
  -d '{
    "reason": "human requested retry on a clean workspace",
    "requestedBy": "operator"
  }' \
  "http://runtime.local/v1/runs/$RUN_ID/actions/cancel"
```

Use `interrupt` when you want the provider to stop and surface control if it can.

Use `cancel` when the run should terminate even if that means force-killing the session after the grace period.

## Common Failure Modes

### Provider bootstrap timeout

Signals:

- run stuck in `bootstrapping`
- terminal outcome code `provider_bootstrap_timeout`
- runtime issue details include `bootstrapTimeoutSec`

What to do:

1. inspect the latest run events
2. confirm the provider binary and auth state are valid
3. retry only if the failure looks transient
4. mark the ticket `Blocked` if the provider cannot become ready without a human fix

### Waiting-human session ended unexpectedly

Signals:

- run ended while it still needed a reply
- provider outcome codes such as `waiting_human_session_ended` or `codex_exited_waiting_human`

What to do:

1. inspect the event stream
2. decide whether to resubmit the work or ask an operator to re-run the phase
3. record the operator decision in the artifact or Linear trail if it changes ticket handling

### Database open or migration failure

Signals:

- daemon fails during startup
- errors such as `database_open_failed` or `migration_failed`

What to do:

1. verify the configured `state_dir` exists and is writable
2. verify the SQLite file is not held by a conflicting process
3. restart after fixing the filesystem problem
4. avoid manual database edits unless you are deliberately doing recovery work

### Socket already in use or stale socket path

Signals:

- daemon fails to bind the transport
- an old socket file exists under `./.harness/state/sockets`

What to do:

1. confirm no active daemon is already serving that socket
2. restart the daemon
3. if the path is stale, the runtime server can remove recoverable stale socket files on startup, but verify the old process is really gone first

### Live session not found

Signals:

- action call returns `accepted: false`
- runtime error code `live_session_not_found`

What to do:

1. fetch the current run record
2. confirm whether the run is already terminal
3. if the run is still marked active, inspect events and consider it a reconciliation problem

### Recovered stale runs after restart

Signals:

- previously active runs now show `stale`
- events include stale recovery behavior

What to do:

1. inspect whether the underlying ticket was already advanced in Linear or Notion
2. if not, treat it as a human decision about retry versus block
3. avoid assuming the old provider session is still valid

## When To Retry Vs Block

Retry locally when:

- the daemon simply was not running
- the socket path was stale
- a transient provider bootstrap problem looks fixable

Escalate or mark the ticket `Blocked` when:

- provider auth is missing or invalid
- the run needs a product or implementation decision
- the runtime state and planning state have diverged and the safe next step is unclear
- filesystem or database problems need host-level intervention

## Operator Checklist

1. Confirm the daemon is running.
2. Check `GET /v1/health`.
3. Check `GET /v1/capacity` if work is queued or starved.
4. Inspect the run record and recent events.
5. Use `human-input`, `interrupt`, or `cancel` deliberately.
6. If the run becomes a ticket-level blocker, reflect that in the planning and artifact surfaces.
