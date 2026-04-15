# Runtime API

This file freezes the first concrete API for the agent runtime service.

## 1. Default deployment shape

The runtime service should run as a host-local daemon.

Recommended default:

- one daemon per machine
- one durable SQLite database for runtime state
- one local-only API surface
- many repositories can submit runs to the same daemon

Why this is the right v1:

- concurrency can be enforced across all repos on the machine
- provider binary checks and warm caches stay centralized
- the orchestrator does not need to manage subprocess lifetime
- no public network surface is required

## 2. Transport choice

Use HTTP/JSON semantics, but do not expose a public port by default.

Recommended binding:

- Unix domain socket on macOS/Linux
- named pipe on Windows
- loopback TCP only as a fallback

This gives you:

- a simple debuggable API
- easy integration from TypeScript, Python, or another orchestrator later
- no need to commit to gRPC or bespoke IPC too early

## 3. Service responsibilities

The runtime service owns:

- run queue and admission control
- PTY-backed provider session lifecycle
- workspace allocation
- heartbeats and idle detection
- normalized issue detection from provider output
- append-only event log

The orchestrator owns:

- deciding which issue phase to run
- deciding when a run should be submitted
- deciding how runtime outcomes map back into Linear and Notion

## 4. Run state machine

Run states:

- `queued`
- `admitted`
- `launching`
- `bootstrapping`
- `running`
- `waiting_human`
- `stopping`
- `completed`
- `failed`
- `canceled`
- `stale`

Transition rules:

1. `queued -> admitted`
2. `admitted -> launching`
3. `launching -> bootstrapping`
4. `bootstrapping -> running`
5. `running -> waiting_human`
6. `waiting_human -> running`
7. `running -> completed | failed | canceled | stale`
8. `waiting_human -> canceled | stale`
9. `launching | bootstrapping -> failed | canceled`
10. `completed | failed | canceled | stale` are terminal

Important distinctions:

- `queued` means waiting for a slot
- `admitted` means a slot and workspace have been reserved
- `bootstrapping` means the process exists but is not yet trusted as ready
- `waiting_human` means the provider is live but requires a human answer
- `stale` means the runtime lost confidence in liveness or ownership

## 5. Request model

Every run should be submitted explicitly by the orchestrator.

Canonical request shape:

```ts
import type { RunSubmissionPayload } from "../src/domain-model.js";

type CreateRunRequest = RunSubmissionPayload;
```

Required policy:

- the orchestrator must provide `runId`
- `runId` is the idempotency key
- repeated `POST /v1/runs` with the same `runId` must return the existing run

## 6. API surface

### 6.1 `POST /v1/runs`

Purpose:

- create or return a run

Behavior:

- if `runId` is new, persist a `queued` run and emit `run_enqueued`
- if `runId` already exists, return the existing run without creating a duplicate

Response:

```json
{
  "run": {
    "runId": "run-2026-04-12-001",
    "workItemId": "issue-id",
    "workItemIdentifier": "ORQ-16",
    "phase": "implement",
    "provider": "codex",
    "status": "queued",
    "repoRoot": "/repo",
    "workspace": {
      "mode": "ephemeral_worktree",
      "assignedBranch": "hillkimball/orq-16-define-canonical-domain-model-and-cross-layer-contracts",
      "pullRequestUrl": "https://github.com/kimballh/orqestrate/pull/16",
      "writeScope": "repo"
    },
    "grantedCapabilities": ["github.read_pr", "github.push_branch"],
    "promptContractId": "orqestrate/implement/v1",
    "promptProvenance": {
      "selection": {
        "promptPackName": "default",
        "capabilityNames": ["github.read_pr"],
        "organizationOverlayNames": ["reviewer_qa"],
        "projectOverlayNames": ["reviewer_webapp"],
        "experimentName": "reviewer_v2"
      },
      "sources": [
        {
          "kind": "base_pack",
          "ref": "prompt-pack:default/base/system.md",
          "digest": "sha256:base-pack"
        }
      ],
      "rendered": {
        "systemPromptLength": 412,
        "userPromptLength": 1867,
        "attachmentKinds": ["planning_url", "artifact_url"],
        "attachmentCount": 2
      }
    },
    "createdAt": "2026-04-12T20:00:00.000Z"
  }
}
```

### 6.2 `GET /v1/runs/:runId`

Purpose:

- read the current canonical run record

Response includes:

- run metadata
- current status
- workspace allocation summary
- safe prompt provenance for diagnosis and replay setup
- last event cursor

### 6.3 `GET /v1/runs`

Purpose:

- list runs for operator dashboards and orchestrator reconciliation

Supported filters:

- `status`
- `provider`
- `workItemId`
- `phase`
- `repoRoot`
- `limit`
- `cursor`

List items use the same canonical run shape as `GET /v1/runs/:runId`, including `promptProvenance` when available and `null` for legacy rows created before prompt provenance was stored.

### 6.4 `POST /v1/runs/:runId/actions/interrupt`

Purpose:

- request a soft interrupt without killing the session

Behavior:

- persist an `interrupt_requested` event
- let the provider adapter decide how to deliver the interrupt
- no-op for terminal runs

Response:

```json
{
  "accepted": true,
  "runId": "run-2026-04-12-001",
  "status": "running"
}
```

### 6.5 `POST /v1/runs/:runId/actions/cancel`

Purpose:

- request termination of the run

Request:

```json
{
  "reason": "issue requeued by human",
  "requestedBy": "linear-orchestrator"
}
```

Behavior:

- persist `cancel_requested`
- transition `running|waiting_human -> stopping`
- supervisor attempts graceful cancellation first, then force kill on timeout

### 6.6 `POST /v1/runs/:runId/actions/human-input`

Purpose:

- provide an answer or approval to a `waiting_human` run

Request:

```json
{
  "kind": "answer",
  "message": "Use the existing shared API adapter instead of creating a new one.",
  "author": "kimballhill"
}
```

Behavior:

- persist `human_input_received`
- adapter injects the message into the live session
- transition `waiting_human -> running` once delivery succeeds

### 6.7 `GET /v1/runs/:runId/events`

Purpose:

- pull append-only events

Query params:

- `after`
- `limit`

Response:

```json
{
  "events": [
    {
      "seq": 42,
      "runId": "run-2026-04-12-001",
      "eventType": "session_ready",
      "level": "info",
      "occurredAt": "2026-04-12T20:01:00.000Z",
      "payload": {
        "provider": "codex"
      }
    }
  ],
  "nextCursor": 42
}
```

### 6.8 `GET /v1/runs/:runId/stream`

Purpose:

- stream runtime events for live dashboards and debugging

Transport:

- Server-Sent Events

Rules:

- event id = `seq`
- clients resume with `Last-Event-ID`
- stream contains normalized events only, not raw terminal bytes by default

### 6.9 `GET /v1/capacity`

Purpose:

- expose scheduler state

Response:

```json
{
  "global": {
    "max": 4,
    "running": 2,
    "queued": 3
  },
  "providers": {
    "codex": { "max": 3, "running": 2 },
    "claude": { "max": 1, "running": 0 }
  },
  "repos": [
    {
      "repoRoot": "/repo-a",
      "running": 1
    }
  ]
}
```

### 6.10 `GET /v1/health`

Purpose:

- liveness and readiness for the daemon

Readiness should fail when:

- the runtime database is unavailable
- the event pump is not running
- no provider adapter can be initialized

## 7. Admission control

The runtime service should make scheduling decisions from the persistent queue, not from transient memory alone.

Admission rules for a `queued` run:

- a global slot is available
- a provider slot is available
- the repository slot policy allows another run
- no other non-terminal run exists for the same `workItemId`
- workspace preparation succeeds

Default scheduling order:

1. lowest numeric `priority`
2. oldest `createdAt`

Do not make admission depend on tmux presence.

## 8. Event taxonomy

The API should expose a small normalized event set.

Recommended `eventType` values:

- `run_enqueued`
- `run_admitted`
- `workspace_preparing`
- `workspace_ready`
- `session_launch_started`
- `session_ready`
- `prompt_submitted`
- `heartbeat`
- `runtime_issue_detected`
- `waiting_human`
- `human_input_received`
- `interrupt_requested`
- `cancel_requested`
- `termination_started`
- `completed`
- `failed`
- `canceled`
- `stale`

Event payloads may differ by type, but the envelope should stay fixed:

```ts
type RunEventEnvelope = {
  seq: number;
  runId: string;
  eventType: string;
  level: "debug" | "info" | "warn" | "error";
  source: "api" | "scheduler" | "workspace" | "supervisor" | "provider";
  occurredAt: string;
  payload: Record<string, unknown>;
};
```

## 9. Runtime issue detection

The runtime service should normalize provider trouble into a small set of issue codes.

Suggested issue codes:

- `provider_not_installed`
- `provider_bad_launch_args`
- `provider_bootstrap_timeout`
- `provider_not_ready`
- `provider_waiting_human`
- `provider_permission_prompt`
- `provider_git_conflict`
- `provider_idle_timeout`
- `provider_wall_time_exceeded`
- `provider_nonzero_exit`
- `transport_broken`
- `workspace_prepare_failed`
- `workspace_dirty_on_release`

These should be emitted as `runtime_issue_detected` events and reflected in the run record.

## 10. Timeout policy

Every run should carry three timeouts:

- `bootstrapTimeoutSec`
- `idleTimeoutSec`
- `maxWallTimeSec`

Recommended first-pass defaults:

- bootstrap: `120`
- idle: `300`
- wall time: `5400`

When these fire:

- bootstrap timeout -> `failed`
- idle timeout -> `stale` or `failed` depending on heartbeat evidence
- wall time -> `canceled` if operator initiated, otherwise `failed`

## 11. API compatibility rule

Keep the API provider-neutral.

That means:

- no provider-specific flags in the public request body
- no provider-specific terminal strings in the event API
- no Codex-specific state names in the run record

Provider-specific behavior belongs behind the adapter boundary.

## 12. First implementation recommendation

Build the runtime service as:

- a TypeScript daemon
- HTTP/JSON API over a Unix socket or named pipe
- SQLite with WAL mode
- one PTY-backed supervisor per admitted run
- one Codex adapter first
- one Claude adapter second

That is enough to start implementation without committing to tmux or a distributed control plane.
