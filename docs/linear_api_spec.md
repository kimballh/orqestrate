# Linear API Spec

This file turns the harness model into an implementation-facing Linear integration contract.

The goal is not to mirror the entire Linear schema. The goal is to pin down:

- the query shapes the orchestrator should use
- the mutation sequence for claim, run, and terminal updates
- the webhook wakeup queue contract

Important boundary:

- the GraphQL query and mutation shapes below are concrete where the official Linear docs are explicit
- the exact representation of custom-field reads and writes must still be verified against the current Linear schema or SDK-generated types before coding

That split is intentional. It keeps the orchestrator logic stable while isolating schema-specific custom-field binding in one adapter.

## 1. Source-backed API assumptions

These assumptions are grounded in current Linear docs:

- Linear exposes a GraphQL API at `https://api.linear.app/graphql`
- list queries are cursor-paginated using `first` and `after`
- list queries can be ordered by `updatedAt`
- filters should be pushed into GraphQL rather than done entirely in client code
- webhooks are the preferred wakeup mechanism for change detection
- reconciliation polling should be filtered and recent-change oriented, not per-issue polling

Official references:

- `https://linear.app/developers/graphql`
- `https://linear.app/developers/filtering`
- `https://linear.app/docs/api/pagination`
- `https://linear.app/developers/rate-limiting`
- `https://linear.app/docs/api-and-webhooks`

## 2. Startup metadata the orchestrator should cache

The orchestrator should resolve and cache this metadata at startup:

- Linear team ids the harness is allowed to act on
- workflow state ids for `Backlog`, `Design`, `Plan`, `Implement`, `Review`, `Blocked`, `Done`, and `Canceled`
- label ids only if the implementation uses ids instead of label names
- custom field definitions and option ids for all machine-owned harness fields

Two rules matter here:

- do not hardcode workflow state ids
- do not scatter custom-field ids or enum-option ids through the codebase

Keep those in one adapter module.

### 2.1 Workflow state bootstrap query

Linear documents `workflowStates` explicitly, so use that as the baseline bootstrap query:

```graphql
query WorkflowStates {
  workflowStates {
    nodes {
      id
      name
    }
  }
}
```

If multiple teams reuse the same state names, the implementation should either:

- run team-specific discovery through the current schema or SDK types, or
- keep an explicit configuration map of `team_id -> workflow state ids`

Do not rely on globally unique state names across teams.

## 3. Query portfolio

The orchestrator only needs a small query set.

### 3.1 Actionable sweep

Use one cheap sweep query to find candidate issues in actionable human-facing statuses.

```graphql
query ActionableSweep($first: Int = 25, $after: String) {
  issues(
    first: $first
    after: $after
    orderBy: updatedAt
    filter: {
      state: {
        name: {
          in: ["Design", "Plan", "Implement", "Review"]
        }
      }
    }
  ) {
    nodes {
      id
      identifier
      title
      updatedAt
      state {
        id
        name
      }
      labels {
        nodes {
          id
          name
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

Why this query stays intentionally narrow:

- the sweep should shortlist candidates, not fully load every issue
- team scoping and harness-field claimability can be applied client-side if that is simpler in v1
- once the exact team-filter and custom-field filter shapes are verified against the current schema, the adapter can narrow this further

Recommended v1 sweep defaults:

- `first = 25`
- order by `updatedAt`
- scan only actionable statuses
- short-circuit once enough claimable work has been found

### 3.2 Targeted issue refresh

Every webhook wakeup and every shortlisted sweep result should be followed by a full issue refresh before taking action.

```graphql
query IssueById($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    updatedAt
    state {
      id
      name
      type
    }
    assignee {
      id
      name
      email
    }
    labels {
      nodes {
        id
        name
      }
    }
    project {
      id
      name
    }
  }
}
```

This selection set should be extended by the adapter with:

- machine-owned custom field values
- any issue relations the phase resolver depends on
- optional PR/link attachment data if implementation or review depends on it

Important rule:

- do not make scheduling decisions from the webhook payload
- do not make scheduling decisions from the sweep row alone
- always decide from a fresh issue read

### 3.3 Optional recent-change reconciliation sweep

If the implementation wants a faster reconciliation path than a full actionable scan, run the same sweep with a moving `updatedAt` window after schema verification.

That is an optimization, not a requirement for v1.

## 4. Custom-field adapter contract

This is the most important structural boundary in the whole design.

The orchestrator core should never know how Linear custom fields are physically represented in GraphQL.

Instead, it should depend on an adapter with two responsibilities:

1. read Linear issue custom-field data into a normalized internal shape
2. build Linear `issueUpdate` input patches from normalized internal changes

Suggested normalized shape:

```ts
type HarnessFields = {
  phase: "none" | "design" | "plan" | "implement" | "review" | "merge";
  state: "idle" | "queued" | "claimed" | "running" | "waiting_human" | "failed" | "completed";
  owner: string | null;
  runId: string | null;
  leaseUntil: string | null;
  artifactUrl: string | null;
  reviewOutcome: "none" | "changes_requested" | "approved" | null;
  blockedReason: string | null;
  lastError: string | null;
  attemptCount: number | null;
};
```

Required adapter interface:

```ts
type LinearHarnessAdapter = {
  read(issue: unknown): HarnessFields;
  buildClaimPatch(input: {
    phase: HarnessFields["phase"];
    owner: string;
    runId: string;
    leaseUntil: string;
  }): Record<string, unknown>;
  buildRunningPatch(input: {
    owner: string;
    runId: string;
    leaseUntil: string;
  }): Record<string, unknown>;
  buildLeaseRenewalPatch(input: {
    owner: string;
    runId: string;
    leaseUntil: string;
  }): Record<string, unknown>;
  buildTerminalPatch(input: Partial<HarnessFields>): Record<string, unknown>;
};
```

Do not inline custom-field write shapes in the scheduler, poller, or phase runners.

## 5. Mutation sequence

Linear explicitly documents `issueUpdate`, so the orchestrator should standardize on that mutation surface for all status and machine-field writes.

### 5.1 Baseline mutation shape

```graphql
mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue {
      id
      identifier
      updatedAt
      state {
        id
        name
      }
    }
  }
}
```

The orchestrator should use this single mutation shape for:

- claim
- transition to running
- lease renewal
- terminal success
- recoverable failure
- human-waiting or blocked transitions

### 5.2 Claim sequence

Recommended claim algorithm:

1. Refresh the issue with `IssueById`.
2. Read normalized harness fields through the adapter.
3. Verify claimability:
   - status maps to one active phase
   - `harness_state` is absent, `queued`, or `failed`
   - lease is absent or expired
   - required upstream artifact exists
4. Create a new run id.
5. Call `issueUpdate` with the adapter-generated claim patch.
6. Confirm `success = true`.
7. Re-read the issue if the mutation response does not include all fields needed for dispatch.
8. Only then dispatch the phase runner.

Example input assembly for an implementation claim:

```ts
const input = {
  stateId: inProgressStateId,
  ...adapter.buildClaimPatch({
    phase: "implement",
    owner: "orchestrator-01",
    runId: "run-2026-04-12-001",
    leaseUntil: "2026-04-12T20:15:00.000Z",
  }),
};
```

Design note:

- for `design`, `plan`, and `review`, you may keep the human-facing state unchanged during the `claimed` transition if that is easier for operators to reason about
- for `implement`, keeping the planning status at `Implement` and letting `harness_state` show `claimed` or `running` is usually the clearest operator experience

### 5.3 Transition from claimed to running

Once the phase runner has actually started, write a second update:

```ts
const input = {
  ...adapter.buildRunningPatch({
    owner: "orchestrator-01",
    runId: "run-2026-04-12-001",
    leaseUntil: "2026-04-12T20:15:00.000Z",
  }),
};
```

This keeps `claimed` short-lived and makes stale dispatch failures visible.

### 5.4 Lease renewal

Renew only while there is real evidence of forward progress.

```ts
const input = {
  ...adapter.buildLeaseRenewalPatch({
    owner: "orchestrator-01",
    runId: "run-2026-04-12-001",
    leaseUntil: "2026-04-12T20:20:00.000Z",
  }),
};
```

Do not renew a lease just because a worker process still exists. Renew because it is still making progress.

### 5.5 Terminal success mutations

Use the same `issueUpdate` mutation shape for all successful transitions.

#### Design complete

```ts
const input = {
  stateId: needsPlanStateId,
  ...adapter.buildTerminalPatch({
    phase: "plan",
    state: "queued",
    owner: null,
    runId: currentRunId,
    leaseUntil: null,
  }),
};
```

If design and planning are intentionally collapsed, use `readyStateId` and `phase: "implement"` instead.

#### Plan complete

```ts
const input = {
  stateId: readyStateId,
  ...adapter.buildTerminalPatch({
    phase: "implement",
    state: "queued",
    owner: null,
    runId: currentRunId,
    leaseUntil: null,
  }),
};
```

#### Implementation complete

```ts
const input = {
  stateId: inReviewStateId,
  ...adapter.buildTerminalPatch({
    phase: "review",
    state: "queued",
    owner: null,
    runId: currentRunId,
    leaseUntil: null,
  }),
};
```

#### Review complete with rework

```ts
const input = {
  stateId: inProgressStateId,
  ...adapter.buildTerminalPatch({
    phase: "implement",
    state: "queued",
    owner: null,
    runId: currentRunId,
    leaseUntil: null,
    reviewOutcome: "changes_requested",
  }),
};
```

#### Review complete with approval

```ts
const input = {
  stateId: readyToMergeStateId,
  ...adapter.buildTerminalPatch({
    phase: "merge",
    state: "queued",
    owner: null,
    runId: currentRunId,
    leaseUntil: null,
    reviewOutcome: "approved",
  }),
};
```

#### Merge complete

```ts
const input = {
  stateId: doneStateId,
  ...adapter.buildTerminalPatch({
    phase: "none",
    state: "completed",
    owner: null,
    runId: currentRunId,
    leaseUntil: null,
  }),
};
```

### 5.6 Failure mutations

Recoverable failure:

```ts
const input = {
  ...adapter.buildTerminalPatch({
    state: "failed",
    owner: null,
    leaseUntil: null,
    lastError: "provider timeout while generating review summary",
  }),
};
```

Blocked or waiting human:

```ts
const input = {
  stateId: blockedStateId,
  ...adapter.buildTerminalPatch({
    state: "waiting_human",
    owner: null,
    leaseUntil: null,
    blockedReason: "missing repository write access",
  }),
};
```

### 5.7 Concurrency limitation

Linear's documented `issueUpdate` shape is enough to build the harness, but it is not a compare-and-set primitive.

That means claim safety comes from:

- refresh-before-write
- short leases
- deterministic owner and run ids
- post-write confirmation
- periodic lease recovery

If duplicate claims become common in practice, add a secondary lock store. Do not prematurely complicate v1.

## 6. Webhook wakeup queue contract

The queue is a transport layer, not the workflow state machine.

It exists only to wake the orchestrator up with bounded, durable work items.

### 6.1 Normalized event envelope

```json
{
  "event_id": "uuid",
  "provider": "linear",
  "delivery_id": "provider-delivery-id-or-derived-hash",
  "resource_type": "Issue",
  "resource_id": "linear-resource-id",
  "issue_id": "linear-issue-id",
  "action": "create|update|remove",
  "received_at": "2026-04-12T20:00:00.000Z",
  "dedupe_key": "linear:Issue:<issue_id>",
  "attempts": 0,
  "status": "queued"
}
```

If the webhook resource is a comment or label event, `issue_id` should still be populated with the owning issue id so the scheduler can always refresh the issue directly.

### 6.2 Queue row lifecycle

Recommended queue states:

- `queued`
- `processing`
- `done`
- `dead_letter`

Recommended transitions:

1. receiver inserts `queued`
2. worker claims row and marks `processing`
3. worker refreshes issue from Linear and decides action
4. worker marks `done` if processing succeeded or no action was needed
5. worker increments `attempts` and requeues on transient failure
6. worker marks `dead_letter` after bounded retries

### 6.3 Dedupe rule

The queue should dedupe by issue, not by exact webhook payload.

Good default:

- one live queued item per `dedupe_key`
- if another webhook arrives for the same issue while one is queued, coalesce it
- once processing starts, allow a new queued item only if another delivery arrives later

That model preserves wakeups without flooding the scheduler.

### 6.4 Receiver contract

The webhook receiver should:

1. verify the Linear signature
2. parse only the fields needed for routing
3. normalize into the queue envelope
4. persist or upsert the queue row
5. return `200` quickly

Do not:

- call Notion inline
- perform claim logic inline
- dispatch Codex inline

### 6.5 Scheduler contract

The scheduler should:

1. read a queued event
2. fetch the current issue with `IssueById`
3. resolve phase and claimability from current Linear state
4. either dispatch work or mark the event processed with no-op

Important rule:

- queue rows are disposable
- Linear remains the source of truth

## 7. Polling contract around the webhook queue

Even in the ideal hybrid design, polling remains permanent.

Use three poll loops:

### 7.1 Actionable sweep

- cadence: every `1-5 minutes`
- purpose: recover from missed webhook deliveries and process work after restarts
- query: `ActionableSweep`

### 7.2 Lease sweep

- cadence: every `30-60 seconds`
- purpose: find expired `claimed` or `running` work and make it reclaimable
- read path: targeted issue refresh for recently active issues

### 7.3 Drift reconciliation

- cadence: every `10-30 minutes`
- purpose: verify Linear status, machine fields, and Notion artifact state still agree

## 8. Implementation guidance

Recommended implementation choices:

- use the Linear SDK if the harness is written in TypeScript, because generated types reduce schema drift risk
- keep the normalized `HarnessFields` type internal to the harness
- centralize all Linear id and custom-field resolution in one module
- keep the queue store simple in v1: SQLite, Postgres, or another small durable store is enough
- prefer small `first` values and recent-change ordering over broad scans

Do not:

- poll each issue individually
- encode lifecycle meaning in labels
- let Notion become the source of claim or lease truth
- spread custom-field GraphQL details through orchestration logic

## 9. Remaining implementation risk

The only intentionally unresolved surface in this spec is the exact Linear custom-field binding.

Before coding, verify:

- the query selection for reading issue custom-field values
- the exact `issueUpdate` input shape for writing those values
- the enum-option ids or write format for `harness_phase`, `harness_state`, and `review_outcome`

2026-04-14 update:

- public schema introspection and the shipped `@linear/sdk@81.0.0` types show no verifiable machine-owned custom-field fields on `Issue`
- `IssueCreateInput` and `IssueUpdateInput` likewise expose no write shape for those fields
- until that binding exists, the Linear backend must not pretend it can safely make actionable scheduling decisions from leased / claimed state

Once that adapter is pinned down, the rest of the harness API contract is stable enough to implement.
