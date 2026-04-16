---
title: Overview
description: Learn what Orqestrate coordinates across planning, context, execution, and validation.
template: splash
hero:
  title: The orchestration layer for coding agents
  tagline: Coordinate planning, context, execution, and validation so agents can operate inside real engineering workflows instead of isolated chat sessions.
  actions:
    - text: Getting Started
      link: /docs/getting-started/
      icon: right-arrow
    - text: View on GitHub
      link: https://github.com/kimballh/orqestrate
      icon: external
      variant: minimal
---

Orqestrate is built around a simple premise:

> The model is not the whole product. The harness is.

It connects the systems that already exist around software delivery:

- planning systems such as Linear
- context systems such as Notion and repository docs
- execution agents such as Codex and Claude Code
- validation loops such as tests and browser-driven checks

## What it coordinates

### Planning

Work enters from the systems the team already trusts for prioritization, dependencies, and status.

### Context

Artifacts, repository knowledge, and prior decisions are assembled into a usable execution bundle instead of living in one fragile chat session.

### Execution

Agent runs happen in isolated worktrees and prepared environments so parallel work stays practical.

### Validation

Outcomes come back with evidence, not just generated code: build checks, tests, and room for browser-based flow validation.

## Why it feels different

Orqestrate is local-first by design. That means teams can keep using the real tools already authenticated on their machines:

- Codex CLI or Claude Code runtimes
- browser automation like Playwright
- OAuth-backed tools and MCP servers
- existing repository layouts and worktree workflows

## Where to go next

- Start with the [Getting Started](/docs/getting-started/) guide for the current local workflow.
- Read [Architecture](/docs/architecture/) for the current MVP model.
