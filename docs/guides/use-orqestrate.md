# Use Orqestrate Day To Day

## Core model

Orqestrate is designed around a simple flow:

`design -> plan -> implement -> review -> merge`

One ticket should have one active phase at a time.

## Planning and context

The initial MVP target uses:

- Linear as the planning and dispatch control plane
- Notion as the durable artifact and run-history surface

That means:

- Linear owns workflow status and machine-owned orchestration state
- Notion owns long-form design, plan, implementation evidence, and review artifacts

## Runtime responsibilities

The runtime daemon owns:

- process supervision
- workspace lifecycle
- run state persistence
- interrupt and cancel behavior
- human-input reinjection

## Useful commands

Check installed help:

```bash
orq --help
```

Inspect runtime commands:

```bash
orq runtime --help
```

Inspect orchestrator commands:

```bash
orq orchestrator --help
```

Inspect run diagnostics:

```bash
orq run list
```

Inspect prompt tooling:

```bash
orq prompt --help
```

## Operator mindset

Even as the product moves toward autonomous orchestration, there are still a few practical surfaces operators will care about:

- whether the orchestrator is running and can claim actionable work
- whether the runtime is healthy
- whether a run is blocked on human input
- whether credentials and provider configuration are valid
- whether the planning and context providers are aligned with the selected profile

For runtime-focused troubleshooting, use [../operator_runbook.md](../operator_runbook.md).
