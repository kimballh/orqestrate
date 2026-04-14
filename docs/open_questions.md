# Open Questions

These are the next decisions to settle before implementing the service.

## 1. Linear claim semantics

- Can the orchestrator safely emulate compare-and-set updates with the Linear API?
- If not, do we need a secondary lock store?
- Is `harness_lease_until` enough to avoid duplicate claims in practice?

## 1a. Webhook ingress store

- What store should hold webhook wakeup events?
- Is a lightweight local durable queue enough?
- Do we want strict delivery dedupe or only short-window issue-id coalescing?

## 1b. Linear custom-field adapter

- 2026-04-14 verification against the public GraphQL schema and `@linear/sdk@81.0.0` showed that `Issue`, `IssueCreateInput`, and `IssueUpdateInput` do not expose a verifiable machine-owned custom-field read/write surface.
- Remaining decision: does Linear expose those harness fields through a private/beta API, or does Orqestrate need a different control-plane store for phase, lease, run, and review state?
- If a supported Linear binding does exist later, should the harness bind to raw GraphQL documents directly or use the Linear TypeScript SDK as the typed adapter layer?

## 2. Required vs optional design phase

- Should every issue pass through `Design` first?
- Or should `Design` be used only when labels like `uiux` are present?

## 3. Merge phase

- Do we want a distinct merge-oriented planning status?
- Or should approved review move directly to `Done` while `merge` remains a separate out-of-band human step?

## 4. Review ownership

- Is review always machine-executed first?
- Can a human review clear `review_outcome` or set it directly?
- Should machine review be mandatory for every implementation?

## 5. Retry policy

- How many retries per phase?
- Should retries be per issue or per phase?
- When does `failed` become `Blocked` automatically?

## 6. Artifact completeness checks

- What exact fields make a design artifact "ready"?
- What exact sections make a plan artifact "ready"?
- What minimum evidence is required before implementation can move to review?

## 7. PR integration

- Does implementation create a branch and PR automatically?
- Does review operate on a PR diff, a local branch, or both?
- Where should PR URL and commit SHA live?

## 8. Human override protocol

- Which fields can operators change directly?
- Which fields are machine-owned and should be treated as authoritative?
- How should the orchestrator detect intentional human takeover?

## 9. Notion database shape

- Is one artifact page per issue enough?
- Do we want a separate design doc page for larger features later?
- Do we need a separate verification evidence database, or are page sections enough?

## 10. Future decomposition

Even though v1 is sequential, we should decide now whether later versions may:

- split one Linear issue into child execution tasks
- run implementation and review on separate workers
- create shadow subtasks in Linear or keep subtasking internal to the harness

## 11. Agent runtime architecture

- Node PTY library or Rust PTY sidecar for the first supervisor implementation?
- Do we want SSE-only event streaming in v1, or should long-poll also be first-class?
- Should human input always be injected into the live session, or can some providers require restart-with-context replay?
- Do we want a hard per-repo concurrency cap in v1, or just global plus per-provider caps?

## 12. Provider/plugin model

- Do we want third-party providers to register through code plugins, package discovery, or only built-in adapters in v1?
- Should provider capabilities be declared explicitly, or is role-based separation between `PlanningBackend` and `ContextBackend` enough for now?
- Do we want one shared config file for all repos, or support both global and project-local `config.toml` files from the start?
