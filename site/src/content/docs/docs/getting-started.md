---
title: Getting Started
description: Run the current local-first Orqestrate workflow and understand the first commands.
---

The current MVP path is optimized for a local-first setup:

1. install dependencies
2. initialize your config
3. bootstrap the selected profile
4. start the runtime and orchestrator services

## Prerequisites

- Node.js `>=22.12.0`
- npm
- access to any provider credentials referenced by your `config.toml`

## Local quickstart

From the repository root:

```bash
npm install
npm run orq:init -- --profile local
npm run orq:bootstrap
npm run dev
```

In a second terminal, start the orchestrator for the current repository:

```bash
npm run dev:orchestrator -- --repo-root "$PWD"
```

## Installed package path

If you install Orqestrate globally, the primary commands are:

```bash
orq init
orq bootstrap
orq runtime start
orq orchestrator start --repo-root "$PWD"
```

## What happens next

The current operating model uses:

- Linear as the planning surface
- Notion as the durable artifact surface
- a local runtime daemon for execution and persistence
- an orchestrator service to claim work and advance ticket phases

## Useful repo commands

```bash
npm run check
npm run site:dev
npm run site:build
npm run site:check
```

For more detailed bootstrap and contributor guidance, see the repo-local docs in `docs/guides/` and `docs/contributor_workflow.md`.
