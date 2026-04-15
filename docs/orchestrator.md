# Orchestrator Model

This file defines the sequential orchestrator loop for the harness.

## 1. Non-goal

The orchestrator does not run design, planning, implementation, and review in parallel for the same ticket.

Only one active phase is allowed per issue.

## 2. High-level lifecycle

The orchestrator loop is:

1. Receive a webhook wakeup, autonomous actionable sweep tick, or reconciliation poll tick.
2. Determine the target phase.
3. Attempt to claim the issue with a lease.
4. Ensure the Notion artifact page and run record exist.
5. Dispatch a phase-specific agent run.
6. Renew the lease while work is active.
7. Persist artifacts and evidence to Notion.
8. Write the terminal outcome back to Linear.
9. Release ownership by clearing or advancing the machine state.

Important rule:

- webhook payloads are hints
- Linear is the authoritative workflow state

The orchestrator should never transition a ticket based only on webhook payload contents. It should always re-read current Linear state before acting.

## 3. Target phase resolution

The orchestrator should derive the next action from the canonical planning status and machine fields.

Recommended mapping:

| Linear status | Target phase |
| --- | --- |
| `Design` | `design` |
| `Plan` | `plan` |
| `Implement` | `implement` |
| `Review` | `review` |

Special rules:

- `Backlog` is not actionable unless a human explicitly selects it.
- `Blocked` is not actionable unless a human explicitly clears it.
- `Done` and `Canceled` are terminal.
- `merge` remains a reserved future phase until the planning workflow grows a first-class merge state.

## 4. Claim model

Claiming should be explicit and lease-based.

### On claim

Set:

- `harness_state = claimed`
- `harness_owner = <orchestrator-instance>`
- `harness_run_id = <new run id>`
- `harness_lease_until = now + lease window`
- `harness_phase = <target phase>`

Then write the Notion run row and dispatch the worker.

### While running

Set:

- `harness_state = running`

Renew:

- `harness_lease_until`

The orchestrator should only renew the lease while there is active evidence that the worker is still progressing.

### On lease expiry

If the lease expires without completion:

- the issue becomes reclaimable
- the next poller may re-claim it
- the previous run remains visible in Notion as an incomplete or failed run

## 5. Phase-specific terminal outcomes

### Design success

Actions:

- persist design artifact to Notion
- set status to `Plan` or `Implement`
- set `harness_phase = plan` or `implement`
- set `harness_state = queued`

Rule:

- move directly to `Implement` only if design already includes enough implementation detail and the operator wants design+plan collapsed

### Plan success

Actions:

- persist plan artifact to Notion
- set status to `Implement`
- set `harness_phase = implement`
- set `harness_state = queued`

### Implementation success

Actions:

- persist implementation notes and verification evidence
- set status to `Review`
- set `harness_phase = review`
- set `harness_state = queued`

### Review success

If approved:

- persist review summary
- set `review_outcome = approved`
- by default, set status to `Done`
- set `harness_phase = none`
- set `harness_state = completed`
- clear ownership and lease fields

If changes are requested:

- persist review findings
- set `review_outcome = changes_requested`
- set status to `Implement`
- set `harness_phase = implement`
- set `harness_state = queued`

### GitHub review-loop routing

For PR-backed `Implement` and `Review` work, the orchestrator should also use the
linked pull request as a bounded routing signal on top of the Linear status.

Rules:

- rehydrate PR workspace scope from recent runtime history when a follow-up wakeup
  does not include it explicitly
- read unresolved review threads before prompt assembly for `Implement` and
  `Review` runs
- classify unresolved threads into implementation-side action, reviewer-side
  action, or ambiguous state
- move `Review -> Implement` when unresolved reviewer feedback requires code or
  rebuttal from implementation
- move `Implement -> Review` when the PR is no longer waiting on implementation
- fail closed to `Blocked` when unresolved thread ownership is ambiguous
- before auto-bouncing `Implement -> Review`, re-read the PR and block if the
  same implementer-action thread set still remains unresolved

To keep same-actor review loops classifiable, bounded GitHub review writes and
thread replies should append hidden machine markers that record the run id and
whether the comment came from implementation or review.

### Merge success

`merge` is a reserved future phase, not a default planning status in the initial MVP.

If a future workflow enables merge explicitly:

- persist final summary
- set status to `Done`
- set `harness_phase = none`
- set `harness_state = completed`
- clear ownership and lease fields

## 6. Failure handling

Not every failure should map to the same terminal state.

### Recoverable execution failure

Examples:

- transient provider failure
- temporary network issue
- malformed response that can be retried

Actions:

- keep status unchanged
- set `harness_state = failed`
- increment `attempt_count`
- write `last_error`

The orchestrator can retry later based on retry policy.

### True blocker

Examples:

- missing dependency
- missing product decision
- external service or repo access not available

Actions:

- set status to `Blocked`
- keep `harness_phase` as the current phase
- set `harness_state = waiting_human`
- write `blocked_reason`

### Human review / approval needed

Examples:

- plan requires signoff
- review findings need triage
- merge requires manual approval

Actions:

- keep or move to the most human-legible status
- set `harness_state = waiting_human`
- keep the artifact page current

## 7. Suggested poll loop

Pseudo-flow:

```text
for each actionable issue:
  resolve phase from status + fields
  if not claimable:
    continue

  claim issue in Linear
  ensure Notion artifact page
  create Notion run row
  dispatch agent for phase

  while worker active:
    renew lease
    collect progress

  write artifacts/evidence to Notion
  update run row
  update Linear status + fields
```

In the ideal hybrid design, that loop is triggered in two ways:

- webhook-triggered targeted processing for recently changed issues
- an autonomous actionable sweep that enqueues currently claimable issues through the same wakeup queue
- slower reconciliation polling for drift, missed events, and expired leases

## 8. Claimability rules

An issue is claimable when all of the following are true:

- its Linear status maps to a valid target phase
- `harness_state` is `queued`, `failed`, or absent
- no valid lease exists, or the existing lease is expired
- any required upstream artifact exists

Examples:

- `Plan` should not be claimable if the design artifact is missing and your process requires design first
- `Review` should not be claimable if implementation evidence is missing

## 9. Minimal operator rules

Humans should be allowed to:

- change the Linear status
- clear a blocker
- mark a ticket as human-owned
- reset `harness_state` to `queued`
- update or replace the Notion artifact page manually

The orchestrator should treat those as supported interventions, not data corruption.

## 10. First-pass recommendation

For v1, keep the orchestration service narrow:

- one poller
- one lease owner per issue
- one active phase per issue
- one artifact page per issue
- one run row per attempt
- no parallel subtask decomposition
- no automatic merge

That gives you a tractable state machine and avoids most reconciliation problems.

For the ideal next step after v1:

- keep the same state machine
- add a webhook ingress layer
- keep polling only for reconciliation and recovery
