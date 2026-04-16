---
title: Architecture
description: A high-level view of the planning, context, execution, and validation layers in Orqestrate.
---

Orqestrate is organized around four connected layers:

## Planning layer

Planning systems remain the source of truth for work intake, dependencies, and human-facing status.

- Linear is the current primary planning surface.
- Ticket phases drive which run should happen next.
- Humans remain the orchestrators during the current build phase.

## Context layer

Context systems preserve durable knowledge beyond a single run.

- Notion holds long-form design, planning, and review artifacts.
- `docs/` keeps durable repo-local knowledge that should travel with the codebase.
- Repository state itself remains the implementation truth.

## Execution layer

Execution happens in isolated local environments so agent work stays practical and reproducible.

- Codex and Claude Code are the initial target runtimes.
- Worktree-backed isolation lets multiple tasks run without stepping on each other.
- Setup hooks can prepare implementation workspaces before prompt execution.

## Validation layer

Orqestrate treats verification as part of the product, not an optional afterthought.

- baseline build, type, and test checks are expected for implementation work
- stronger targeted verification should run when the touched surface needs it
- browser-driven flow checks are part of the long-term differentiation of the harness

## Current MVP shape

Today’s build is validating the future operating model in a human-orchestrated loop:

- Linear for planning
- Notion for artifact context
- repo-local docs for durable memory
- local runtimes for execution

That architecture keeps the system grounded in real engineering workflows instead of a single proprietary control surface.
