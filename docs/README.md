# Orqestrate Docs

This directory is the main documentation index for Orqestrate.

Use the sections below based on whether you are:

- using Orqestrate in your own project
- contributing to the Orqestrate codebase
- digging into architecture and implementation details

## User Guides

- [guides/README.md](./guides/README.md) - entrypoint for users of Orqestrate
- [guides/install.md](./guides/install.md) - global install options and CLI verification
- [guides/setup-your-project.md](./guides/setup-your-project.md) - initialize config, choose providers, and bootstrap a project
- [guides/use-orqestrate.md](./guides/use-orqestrate.md) - day-to-day operating model and useful commands

## Contributor Docs

- [contributors/README.md](./contributors/README.md) - entrypoint for contributors to this repository
- [contributor_workflow.md](./contributor_workflow.md) - local repo workflow and implementation update rules
- [operator_runbook.md](./operator_runbook.md) - run, inspect, and troubleshoot the runtime daemon and live runs
- [quality_policy.md](./quality_policy.md) - verification, testing, and CI expectations

## Product Shape

The current MVP target is:

- Linear as the planning system and dispatch control plane
- Notion as the artifact store and run-history surface
- an autonomous orchestrator service that claims actionable tickets and dispatches one phase at a time
- a runtime daemon that executes runs locally

The architecture is intentionally providerized so the same harness can later support:

- other planning systems like Asana
- other context systems like Google Drive
- local-only deployments using file-backed providers for both

## Architecture Reference

- [architecture.md](./architecture.md) - end-to-end implementation review diagram covering config, providers, orchestrator, runtime, persistence, and deployment profiles
- [domain_model.md](./domain_model.md) - canonical shared records, enums, authority boundaries, and serialization rules for cross-layer contracts
- [agent_contract.md](./agent_contract.md) - explicit responsibility split between the code agent, orchestrator, and runtime daemon
- [example_prompts.md](./example_prompts.md) - first-pass prompt templates for design, plan, implement, review, merge, and GitHub PR review loops
- [prompt_customization.md](./prompt_customization.md) - layered prompt overrides, prompt packs, capability fragments, and prompt testing model
- [deployment_topology.md](./deployment_topology.md) - public webhook ingress vs private orchestrator/runtime deployment boundary and service topology
- [provider_architecture.md](./provider_architecture.md) - abstract planning/context backend model, provider registry, and local-files built-ins
- [config_model.md](./config_model.md) - `config.toml` schema with named provider instances and profiles
- [config.example.toml](../config.example.toml) - example config showing SaaS, local, and hybrid profiles
- [linear_model.md](./linear_model.md) - proposed Linear statuses, fields, labels, and transitions
- [linear_api_spec.md](./linear_api_spec.md) - implementation-facing Linear query shapes, mutation sequence, and webhook queue contract
- [agent_runtime.md](./agent_runtime.md) - provider-neutral runtime service between the orchestrator and Codex or Claude
- [runtime_api.md](./runtime_api.md) - host-local runtime daemon API, run state machine, and event surface
- [runtime_schema.md](./runtime_schema.md) - SQLite schema and TypeScript contracts for runs, events, heartbeats, workspaces, and provider adapters
- [notion_model.md](./notion_model.md) - proposed Notion artifact and run-history model
- [orchestrator.md](./orchestrator.md) - sequential orchestration loop, claim model, failure handling
- [webhook_poll_hybrid.md](./webhook_poll_hybrid.md) - ideal ingress model using Linear webhooks for wakeup and polling for reconciliation
- [open_questions.md](./open_questions.md) - unresolved decisions for the next design pass
