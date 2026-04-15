# Contributor Workflow

This guide is the task-first entrypoint for working in Orqestrate without live pairing.

Use it when you need to:

- bootstrap a local workspace
- contribute safely in this repository
- understand which updates belong in Linear, Notion, `docs/`, and git

For the durable operating contract that agents follow inside this repo, also read:

- [`AGENTS.md`](../AGENTS.md)
- [`docs/quality_policy.md`](./quality_policy.md)

## Prerequisites

- Node.js `>=20.18.0`
- `npm`
- a clone of this repository
- for SaaS-backed profiles only: valid Linear and Notion credentials in the environment variables referenced by `config.toml`

The strongest supported path today is still the zero-credential `local` profile.

## Fastest Local Bootstrap

Run:

```bash
npm run setup
```

That script will:

- install dependencies with `npm ci` when `package-lock.json` is present
- create `./config.toml` from `./config.example.toml`
- force the active profile to `local`
- bootstrap the local planning and context providers

After setup, start the runtime daemon:

```bash
npm run dev
```

## Manual Bootstrap

If you want to inspect or control each step directly:

```bash
npm run orq:init -- --profile local
npm run orq:bootstrap
```

Useful help commands:

```bash
npm run orq:init -- --help
npm run orq:bootstrap -- --help
```

If you switch to a non-local profile:

1. Update `config.toml` to point at the right providers and credentials.
2. Re-run `npm run orq:bootstrap`.
3. Start the daemon with `npm run dev` or `npm start`.

## Important Local Paths

With the shipped local config, the main paths resolve to:

- `./config.toml`: active local config
- `./.harness/state/runtime.sqlite`: runtime SQLite database
- `./.harness/state/sockets/runtime.sock`: Unix socket for the runtime API on macOS/Linux
- `./.harness/logs/runtime/`: runtime logs
- `./.harness/local/planning/`: materialized local planning seed
- `./.harness/local/context/`: writable local context root

Those locations come from `config.toml`. Treat that file as authoritative if you customize paths.

## Ticket Flow By Phase

The product is designed around one active phase per ticket:

`design -> plan -> implement -> review -> merge`

### Design

When the assigned phase is `design`:

- read the Linear ticket
- read the relevant local docs and existing Notion artifact
- inspect the codebase
- write or update the long-form design in Notion
- leave a concise Linear comment linking to the artifact

Do not implement code or change repo-tracked files unless the user explicitly asks for it.

### Plan

When the assigned phase is `plan`:

- read the Linear ticket and current artifact
- produce an implementation plan with scope, risks, and verification strategy
- update the same Notion artifact rather than scattering new pages
- leave a concise Linear comment with the plan link

Do not implement code or create a PR unless the user explicitly asks for it.

### Implement

When the assigned phase is `implement`:

- read the Linear ticket
- read the existing Notion artifact if one exists
- make the local repo changes
- run the required verification plus the strongest practical targeted checks
- update Notion with implementation notes and evidence
- leave a concise Linear comment with what changed and how it was verified

When the run is branch-backed:

- use the current assigned branch, or the ticket branch if the worktree is not already on one
- do not invent a second feature branch for the same ticket
- commit the completed implementation
- push the branch
- create or update the PR

### Review

When the assigned phase is `review`:

- inspect the code or PR state relevant to the ticket
- produce findings or an explicit no-findings result
- treat weak or missing verification as a first-class concern
- update the Notion artifact with the review output
- leave a concise Linear comment summarizing the result

Review is read-only by default unless the user explicitly asks for rework.

## What Goes Where

- Linear: ticket status, dependency truth, and concise progress or outcome comments
- Notion: design notes, plans, review notes, implementation evidence, and other long-form durable artifacts
- `docs/`: durable repo-local knowledge that future runs should have even if external tools are unavailable
- source files: implementation truth
- PRs and commits: implementation-phase execution surface

As a rule of thumb:

- `design` and `plan` write long-form outputs to Notion, not repo docs, unless the user explicitly asks for repo-tracked documentation
- `implement` updates repo docs when the change affects durable local knowledge

## Verification Expectations

`docs/quality_policy.md` is normative. The current repo baseline is:

```bash
npm run check
```

That command expands to:

```bash
npm run typecheck
npm run build
npm run test
```

Implementation work should also run the strongest practical targeted verification for the area you touched.

If you change behavior and do not add automated coverage, call out:

- why coverage was not added
- what you verified instead
- what residual risk remains

## Daily Command Reference

```bash
npm run setup
npm run orq:init -- --help
npm run orq:bootstrap -- --help
npm run dev
npm start
npm run check
```

## When To Update Local Docs

Update `docs/` during implementation when:

- a command, path, or workflow expectation changes
- future contributors would otherwise have to rediscover the same decision
- the repo now supports a new operator or contributor path

Do not treat repo docs as a high-frequency status surface.

## Common Escalation Points

Pause and escalate when:

- the user instruction conflicts with the ticket status or dependency graph in a risky way
- the codebase state and the existing Notion artifact disagree materially
- the runtime behavior no longer matches the documented commands or paths
- a ticket is truly blocked and needs a human decision

If blocked:

- record the concrete blocker in your local summary
- update the Notion artifact if the blocker changes the durable plan
- leave a concise Linear comment if the ticket now needs human action
- move the ticket to `Blocked` only when that reflects the actual state of the run
