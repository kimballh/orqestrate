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

1. `Backlog`
2. `Design`
3. `Plan`
4. `Implement`
5. `Review`
6. `Blocked`
7. `Done`
8. `Canceled`

### Status semantics

`Backlog`
- New issue.
- Orchestrator should ignore it unless explicitly asked to act on backlog tickets.

`Design`
- The next required artifact is a design note or UI/UX artifact.

`Plan`
- The next required artifact is an implementation plan.

`Implement`
- Design and planning requirements are satisfied.
- Implementation is active or ready to be claimed.

`Review`
- Implementation exists and an automated or human review is required.

`Blocked`
- Work cannot advance without a dependency, decision, or external action.

`Done`
- Work is complete from the harness perspective.

`Canceled`
- Work was intentionally stopped and should not be claimed again without a human reopening it.

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
- `completed`

Meaning:

- `idle`: no current machine work
- `queued`: ready for the orchestrator to pick up
- `claimed`: orchestrator claimed the ticket but has not started the worker yet
- `running`: an agent is actively executing the current phase
- `waiting_human`: machine paused for human input
- `failed`: last attempt failed and needs operator attention or retry logic
- `completed`: current phase finished successfully

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
| `Backlog` | `none` | not currently actionable |
| `Design` | `design` | next artifact is design |
| `Plan` | `plan` | next artifact is implementation plan |
| `Implement` | `implement` | implementation can start or is active |
| `Review` | `review` | review is active |
| `Blocked` | current phase preserved | work paused |
| `Done` | `none` | no active orchestration phase |
| `Canceled` | `none` | intentionally inactive |

`merge` remains a reserved future phase. If the workflow gains a first-class merge handoff later, it should be modeled through `harness_phase` before adding another planning status.

## 6. Pollable selectors

These are the main selectors the orchestrator should poll.

### Design queue

- status = `Design`
- `harness_phase = design`
- `harness_state IN (queued, failed)` or lease expired

### Plan queue

- status = `Plan`
- `harness_phase = plan`
- `harness_state IN (queued, failed)` or lease expired

### Implementation queue

- status = `Implement`
- `harness_phase = implement`
- `harness_state IN (queued, failed)` or lease expired

### Review queue

- status = `Review`
- `harness_phase = review`
- `harness_state IN (queued, failed)` or lease expired

### Merge queue

- no default merge queue yet
- reserve `harness_phase = merge` for a future workflow revision instead of inventing a planning status early

## 7. Transition rules

Recommended first-pass transitions:

1. `Backlog -> Design`
2. `Backlog -> Plan`
3. `Backlog -> Implement`
4. `Design -> Plan`
5. `Design -> Implement`
6. `Plan -> Implement`
7. `Implement -> Review`
8. `Implement -> Blocked`
9. `Review -> Implement` when rework is needed
10. `Review -> Done` when approved
11. `Blocked -> Design | Plan | Implement | Review`
12. `Design | Plan | Implement | Review | Blocked -> Canceled`

## 8. State update examples

### Claiming implementation work

When the orchestrator claims an `Implement` ticket:

- status stays `Implement`
- `harness_phase = implement`
- `harness_state = claimed`
- `harness_owner = orchestrator-instance-123`
- `harness_run_id = run-2026-04-12-001`
- `harness_lease_until = now + lease_window`

After the worker actually starts:

- status = `Implement`
- `harness_state = running`

### Completing review with rework

If review fails:

- status = `Implement`
- `harness_phase = implement`
- `harness_state = queued`
- `review_outcome = changes_requested`
- `last_error` holds the review summary headline or review failure reason

### Completing review with approval

If review passes:

- status = `Done`
- `harness_phase = none`
- `harness_state = completed`
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
