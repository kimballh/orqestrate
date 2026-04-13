# Webhook / Poll Hybrid

This file defines the ideal ingress model for the harness.

The core recommendation is:

- use Linear webhooks for wakeup and targeting
- use polling for reconciliation and recovery
- keep Linear as the source of truth

This is the best long-term model even if v1 starts as polling only.

## 1. Why hybrid instead of polling-only

Polling-only is attractive because:

- it does not require a public HTTPS endpoint
- it is easy to turn on and off
- it is simple to run locally

But polling-only has structural downsides:

- unnecessary API usage while idle
- slower reaction time
- harder scaling once more issue types and phases are added
- more duplicated reads

Linear explicitly discourages polling for updates and recommends webhooks for change detection. Their current docs also expose request and complexity rate limits, which are generous for small systems but still easy to waste with naive loops.

Relevant official docs:

- https://linear.app/developers/rate-limiting
- https://linear.app/developers/webhooks

The hybrid model gets the best properties of both:

- webhooks reduce idle traffic and improve latency
- polling recovers from downtime, missed deliveries, stale leases, and manual edits

## 2. Architectural principle

Webhooks are not state.

They are event notifications that tell the orchestrator:

- something changed
- which object changed
- when to wake up

The orchestrator should always re-read the current Linear issue state before taking action.

That means:

- webhook payload = wakeup signal
- Linear issue + custom fields = control plane
- Notion artifact page = durable document context
- Notion runs row = append-only run history

## 3. Recommended components

### 3.1 Webhook receiver

Responsibilities:

- expose a public HTTPS endpoint
- verify Linear signature
- parse only the fields needed to route the event
- enqueue a compact internal event record
- return `200 OK` quickly

Do not:

- run the full orchestrator inside the webhook request
- block on Notion writes
- block on agent dispatch

Linear retries failed webhook deliveries only a few times and expects a quick response. The receiver should stay minimal.

### 3.2 Event intake queue

Responsibilities:

- store compact event envelopes
- deduplicate repeated issue wakeups over a short window
- coalesce many updates for the same issue into one work item

Suggested envelope shape:

```json
{
  "provider": "linear",
  "resource_type": "Issue",
  "resource_id": "issue-id",
  "action": "create|update|remove",
  "received_at": "timestamp",
  "delivery_id": "provider-delivery-id-or-derived-hash"
}
```

Important rule:

- this queue is transport state, not workflow state

It can live outside Linear/Notion because it is not authoritative business state. A lightweight local durable store is enough.

### 3.3 Scheduler / dispatcher

Responsibilities:

- consume queue entries
- re-fetch current Linear issue state
- determine whether the issue is actionable
- claim the issue if appropriate
- start the phase runner

The scheduler should be idempotent:

- multiple wakeups for the same issue must be safe
- multiple schedulers should still respect the same claim rules

### 3.4 Reconciliation poller

Responsibilities:

- find actionable issues even if webhooks were missed
- recover issues with expired leases
- detect manual status changes
- detect mismatches between Linear and Notion artifact state
- detect stuck `running` or `claimed` issues

This poller is what makes the system durable.

## 4. Event classes worth listening to

Start narrow.

Recommended initial Linear webhook resource types:

- `Issue`
- `IssueComment`
- `IssueLabel`

Why:

- `Issue` events cover most state transitions and field edits
- `IssueComment` lets human replies or approval comments wake the orchestrator
- `IssueLabel` lets routing changes wake the orchestrator

You do not need every Linear webhook type to start.

## 5. Targeted processing flow

Recommended flow after receiving a webhook:

1. Verify webhook signature.
2. Normalize into a compact issue wakeup event.
3. Push to queue.
4. Worker consumes queue item.
5. Worker fetches current Linear issue state.
6. Worker decides whether the issue is actionable.
7. If actionable and claimable, claim it and run the phase.

The important point is step 5. The webhook payload itself is not the decision surface.

## 6. Reconciliation polling flow

Recommended periodic reconciliation jobs:

### 6.1 Actionable issue sweep

Cadence:

- every `1-5 minutes`

Purpose:

- find claimable issues that were missed by webhook delivery
- pick up newly queued work after service restarts

Selector:

- statuses in `Needs Design`, `Needs Plan`, `Ready`, `In Review`, `Ready to Merge`
- `harness_state` in `queued`, `failed`, or lease expired

### 6.2 Lease sweeper

Cadence:

- every `30-60 seconds`

Purpose:

- find `claimed` or `running` issues whose lease expired
- move them back to a reclaimable state or mark them for inspection

### 6.3 Drift reconciler

Cadence:

- every `10-30 minutes`

Purpose:

- verify the Linear issue, Notion artifact page, and latest run row are still consistent
- catch human edits that changed the expected next phase

## 7. Recommended API usage strategy

To stay well below Linear limits:

- query only minimal fields in list sweeps
- fetch full issue detail only after shortlisting or claiming
- filter tightly by status and relevant machine fields
- order by `updatedAt`
- avoid wide nested queries
- respect rate-limit and complexity headers

Good pattern:

1. cheap list query for candidate issues
2. full issue read for only the selected issue ids
3. mutation to claim only after confirming the issue is still claimable

## 8. Claim strategy in a hybrid model

The hybrid architecture does not change the claim model.

Recommended claim flow:

1. Read current issue state.
2. If the issue is claimable, write:
   - `harness_owner`
   - `harness_run_id`
   - `harness_phase`
   - `harness_state = claimed`
   - `harness_lease_until`
3. Re-read or confirm the mutation result.
4. Start the worker.
5. Move `harness_state` to `running`.

If the worker does not start:

- do not leave the ticket in a long-lived ambiguous state
- either return it to `queued` or mark it `failed`

## 9. Human edits and webhook wakeups

One advantage of the hybrid model is that human intervention becomes first-class.

Examples:

- human changes status from `Blocked` to `Ready`
- human adds `uiux`
- human comments with approval or clarification
- human sets `harness_state` back to `queued`

Those should all generate issue wakeups, after which the orchestrator re-reads the current ticket state and decides whether to act.

## 10. Public endpoint concern

The main cost of webhooks is that you need a public HTTPS receiver.

That does not mean the full orchestrator must be public.

A good split is:

- public edge receiver
- private orchestrator worker

The public edge only:

- validates signature
- writes queue messages
- responds `200`

Everything else stays private.

## 11. Recommended staged rollout

### Stage 1: Polling-only v1

Use:

- actionable issue poller
- lease sweeper
- manual start/stop control

This is the easiest local bring-up path.

### Stage 2: Add webhook ingress

Add:

- public receiver
- event queue
- targeted wakeup processor

Keep:

- all existing pollers

### Stage 3: Reduce polling cost

Once webhook delivery is trusted:

- keep lease sweeper
- keep drift reconciler
- reduce broad actionable sweeps

Do not remove reconciliation polling entirely.

## 12. Recommended vNext decisions

The next concrete implementation decisions should be:

1. what queue/store holds webhook wakeup events
2. what exact Linear query powers the actionable sweep
3. what exact claim mutation/update sequence is safe enough
4. what comment or field changes should count as human approval/unblock signals
