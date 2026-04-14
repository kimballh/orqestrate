# Orqestrate Agent Harness

This directory is the first-pass design for a Codex orchestration harness.

The first provider pair is:

- Linear as the human-facing workflow system and dispatch control plane
- Notion as the artifact store and run-history surface
- an orchestrator service to poll actionable tickets and dispatch one phase at a time

But the architecture is now intentionally providerized so the same harness can later support:

- other planning systems like Asana
- other context systems like Google Drive
- fully local deployments using file-backed providers for both

## Scope

This design is intentionally sequential.

For now, each ticket moves through one active phase at a time:

`design -> plan -> implement -> review -> merge`

The orchestrator does not parallelize those phases, and it does not split a single ticket into concurrent sub-agents by default.

## Design goals

- Keep ticket state understandable to humans in Linear.
- Keep machine-owned orchestration state explicit and pollable.
- Avoid using labels/tags as the primary lifecycle state machine.
- Keep artifacts durable in Notion.
- Make claiming and retries safe enough for a poll-based orchestrator.
- Leave room for human intervention at every phase.
- Keep provider-native details behind backend adapters so planning/context systems can be swapped without rewriting the core.
- Support a zero-dependency local profile using local files for both planning and context.

## Source of truth

The core rule is: one authority per state dimension.

| Concern | Authority |
| --- | --- |
| Human-facing workflow status | Linear status |
| Machine phase + lease + claim owner | Linear custom fields |
| Generated design/plan/review artifacts | Notion issue artifact page |
| Execution/run history | Notion runs database |
| Live worker process state | Orchestrator memory / runtime only |

This mirrors one of the most important lessons from OMX: do not overload one field with multiple meanings.

## Documents

- [architecture.md](./architecture.md) - end-to-end implementation review diagram covering config, providers, orchestrator, runtime, persistence, and local-first deployment
- [domain_model.md](./domain_model.md) - canonical shared records, enums, authority boundaries, and serialization rules for cross-layer contracts
- [agent_contract.md](./agent_contract.md) - explicit responsibility split between the code agent, orchestrator, and runtime daemon
- [example_prompts.md](./example_prompts.md) - first-pass prompt templates for design, plan, implement, review, merge, and GitHub PR review loops
- [quality_policy.md](./quality_policy.md) - current verification, testing, and CI expectations for local runs and future enforcement
- [prompt_customization.md](./prompt_customization.md) - layered prompt overrides, prompt packs, capability fragments, and prompt testing model
- [working_mode.md](./working_mode.md) - current human-orchestrated operating model using Linear, Notion, and local docs while Orqestrate is being built
- [deployment_topology.md](./deployment_topology.md) - public webhook ingress vs private orchestrator/runtime deployment boundary and service topology
- [provider_architecture.md](./provider_architecture.md) - abstract planning/context backend model, provider registry, and local-files built-ins
- [config_model.md](./config_model.md) - `config.toml` schema with named provider instances and profiles
- [config.example.toml](./config.example.toml) - example config showing SaaS, local, and hybrid profiles
- [linear_model.md](./linear_model.md) - proposed Linear statuses, fields, labels, and transitions
- [linear_api_spec.md](./linear_api_spec.md) - implementation-facing Linear query shapes, mutation sequence, and webhook queue contract
- [agent_runtime.md](./agent_runtime.md) - provider-neutral runtime service between the orchestrator and Codex or Claude
- [runtime_api.md](./runtime_api.md) - host-local runtime daemon API, run state machine, and event surface
- [runtime_schema.md](./runtime_schema.md) - SQLite schema and TypeScript contracts for runs, events, heartbeats, workspaces, and provider adapters
- [notion_model.md](./notion_model.md) - proposed Notion artifact and run-history model
- [orchestrator.md](./orchestrator.md) - sequential orchestration loop, claim model, failure handling
- [webhook_poll_hybrid.md](./webhook_poll_hybrid.md) - ideal ingress model using Linear webhooks for wakeup and polling for reconciliation
- [open_questions.md](./open_questions.md) - unresolved decisions for the next design pass

## Initial recommendation

Use:

- abstract `PlanningBackend` and `ContextBackend` families
- `config.toml` with named providers and profiles
- a built-in `local_files` provider for both planning and context
- Linear statuses for the coarse lifecycle
- Linear custom fields for machine phase, lease, run id, and review outcome
- Linear labels only for routing hints like `uiux`, `frontend`, `backend`, `infra`, `docs`
- one Notion artifact page per Linear issue
- one Notion runs database row per orchestration attempt
- webhook-driven wakeup plus periodic reconciliation polling

Avoid:

- one giant cross-tool integration base class
- provider-specific logic in the orchestrator core
- statuses like `in progress (native)` or `done (native)`
- labels like `needs plan` or `ready for implementation`
- using Notion as the high-frequency locking or heartbeat store

Those choices make the system harder to poll, harder to reconcile, and harder for humans to reason about.
