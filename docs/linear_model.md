# Linear Model

This file defines the proposed Linear-side workflow model for the harness.

## 1. Modeling rules

Use Linear for:

- coarse, human-readable ticket status
- machine-readable orchestration fields
- capability/routing labels
- operator override and manual intervention

Do not use labels as the lifecycle state machine.

The rule is:

- status answers "where is this ticket in the workflow?"
- custom fields answer "what is the orchestrator doing right now?"
- labels answer "what kind of work is this?"

## 2. Proposed statuses

Recommended first-pass statuses:

1. `Triage`
2. `Needs Design`
3. `Needs Plan`
4. `Ready`
5. `In Progress`
6. `In Review`
7. `Blocked`
8. `Ready to Merge`
9. `Done`

### Status semantics

`Triage`
- New issue.
- Orchestrator should ignore it unless explicitly asked to act on triage tickets.

`Needs Design`
- The next required artifact is a design note or UI/UX artifact.

`Needs Plan`
- The next required artifact is an implementation plan.

`Ready`
- Design and planning requirements are satisfied.
- The next active machine phase is implementation.

`In Progress`
- Implementation is running or was recently claimed.

`In Review`
- Implementation exists and an automated or human review is required.

`Blocked`
- Work cannot advance without a dependency, decision, or external action.

`Ready to Merge`
- Review passed and the next remaining step is merge/release handling.

`Done`
- Work is complete from the harness perspective.

## 3. Proposed custom fields

These fields should be machine-owned unless a human is intentionally overriding the orchestrator.

### `harness_phase`

Type: enum

Allowed values:

- `none`
- `design`
- `plan`
- `implement`
- `review`
- `merge`

Meaning:

- the single active orchestration phase for the ticket

### `harness_state`

Type: enum

Allowed values:

- `idle`
- `queued`
- `claimed`
- `running`
- `waiting_human`
- `failed`
- `complete`

Meaning:

- `idle`: no current machine work
- `queued`: ready for the orchestrator to pick up
- `claimed`: orchestrator claimed the ticket but has not started the worker yet
- `running`: an agent is actively executing the current phase
- `waiting_human`: machine paused for human input
- `failed`: last attempt failed and needs operator attention or retry logic
- `complete`: current phase finished successfully

### `harness_owner`

Type: text

Meaning:

- orchestrator instance id or worker id that currently owns the lease

### `harness_run_id`

Type: text

Meaning:

- current or most recent run id

### `harness_lease_until`

Type: datetime

Meaning:

- lease expiry for the current claim

### `artifact_url`

Type: URL

Meaning:

- canonical Notion artifact page for this issue

### `review_outcome`

Type: enum

Allowed values:

- `none`
- `changes_requested`
- `approved`

Meaning:

- review result for the latest implementation

### `blocked_reason`

Type: text

Meaning:

- short machine-readable/human-readable blocker summary

### `last_error`

Type: text

Meaning:

- short terminal error from the most recent failed run

### `attempt_count`

Type: number

Meaning:

- total attempts for the current phase

### `execution_mode`

Type: enum

Allowed values:

- `native`
- `human`
- `hybrid`

Meaning:

- whether the issue is currently machine-driven, human-driven, or mixed

## 4. Recommended labels

Labels should stay capability-oriented.

Examples:

- `uiux`
- `frontend`
- `backend`
- `infra`
- `api`
- `docs`
- `security`
- `human-input`
- `external-blocker`

Do not use labels like:

- `needs plan`
- `ready for implementation`
- `in review`
- `done`

Those should be status or structured fields.

## 5. Status-to-phase mapping

| Linear status | Expected `harness_phase` | Meaning |
| --- | --- | --- |
| `Needs Design` | `design` | next artifact is design |
| `Needs Plan` | `plan` | next artifact is implementation plan |
| `Ready` | `implement` | implementation can start |
| `In Progress` | `implement` | implementation is active |
| `In Review` | `review` | review is active |
| `Ready to Merge` | `merge` | merge or finalization is active |
| `Blocked` | current phase preserved | work paused |
| `Done` | `none` | no active orchestration phase |

## 6. Pollable selectors

These are the main selectors the orchestrator should poll.

### Design queue

- status = `Needs Design`
- `harness_phase = design`
- `harness_state IN (queued, failed)` or lease expired

### Plan queue

- status = `Needs Plan`
- `harness_phase = plan`
- `harness_state IN (queued, failed)` or lease expired

### Implementation queue

- status = `Ready`
- `harness_phase = implement`
- `harness_state IN (queued, failed)` or lease expired

### Review queue

- status = `In Review`
- `harness_phase = review`
- `harness_state IN (queued, failed)` or lease expired

### Merge queue

- status = `Ready to Merge`
- `harness_phase = merge`
- `harness_state IN (queued, failed)` or lease expired

## 7. Transition rules

Recommended first-pass transitions:

1. `Triage -> Needs Design`
2. `Triage -> Needs Plan`
3. `Triage -> Ready`
4. `Needs Design -> Needs Plan`
5. `Needs Design -> Ready`
6. `Needs Plan -> Ready`
7. `Ready -> In Progress`
8. `In Progress -> In Review`
9. `In Progress -> Blocked`
10. `In Review -> In Progress` when rework is needed
11. `In Review -> Ready to Merge` when approved
12. `Ready to Merge -> Done`
13. `Blocked -> Needs Design | Needs Plan | Ready | In Progress | In Review`

## 8. State update examples

### Claiming implementation work

When the orchestrator claims a `Ready` ticket:

- status stays `Ready` briefly or moves to `In Progress`
- `harness_phase = implement`
- `harness_state = claimed`
- `harness_owner = orchestrator-instance-123`
- `harness_run_id = run-2026-04-12-001`
- `harness_lease_until = now + lease_window`

After the worker actually starts:

- status = `In Progress`
- `harness_state = running`

### Completing review with rework

If review fails:

- status = `In Progress`
- `harness_phase = implement`
- `harness_state = queued`
- `review_outcome = changes_requested`
- `last_error` holds the review summary headline or review failure reason

### Completing review with approval

If review passes:

- status = `Ready to Merge`
- `harness_phase = merge`
- `harness_state = queued`
- `review_outcome = approved`

## 9. Practical recommendation

For v1, use the status set above and all custom fields except `execution_mode` if you want to keep the schema smaller.

The smallest viable machine field set is:

- `harness_phase`
- `harness_state`
- `harness_owner`
- `harness_run_id`
- `harness_lease_until`
- `artifact_url`
- `review_outcome`
- `blocked_reason`

That is enough for safe polling, claiming, retries, review rework, and Notion artifact linkage.
