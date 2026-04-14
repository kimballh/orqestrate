# Orqestrate Agent Operating Contract

This repository is being built in a human-orchestrated mode before Orqestrate itself exists.

For now:

- the user is the orchestrator
- Codex is the scoped execution agent
- Linear is the planning surface
- Notion is the context and artifact surface
- `docs/` and other local files are also first-class context

## Current operating mode

The user will provide:

- a Linear ticket reference such as `ORQ-123`
- an explicit phase instruction such as `design`, `plan`, `implement`, or `review`
- any priority or dependency guidance needed for the current run

Do not choose new work items on your own.
Do not reorder the queue on your own.
Do not assume the next phase unless the user explicitly instructs it.

## Planning layer: Linear

Current Linear workspace facts:

- team: `Orqestrate`
- project: `Orqestrate Build`
- project URL: `https://linear.app/orqestrate/project/orqestrate-build-374b99442159`

Use Linear as the planning source of truth for:

- the current ticket
- dependencies the user has already encoded
- human-facing progress breadcrumbs

Current preferred Linear workflow statuses:

- `Backlog`
- `Design`
- `Plan`
- `Implement`
- `Review`
- `Blocked`
- `Done`
- `Canceled`

Working rule:

- the Linear status should normally match the phase you want run next
- the user’s explicit instruction remains the authoritative tiebreaker when there is a mismatch or when a ticket needs special handling

That means:

- use `Design`, `Plan`, `Implement`, and `Review` as the normal phase signals
- treat `Blocked` as not actionable unless the user explicitly asks to investigate or unblock it
- treat `Backlog` as not ready for execution unless the user explicitly chooses it
- if the user’s message conflicts with the ticket status, follow the user’s message and call out the mismatch briefly

Unless explicitly asked, do not change:

- assignee
- priority
- dependency graph
- project membership

By default, do update Linear status when it is part of keeping the planning layer accurate for the assigned run:

- move the ticket into the assigned active phase if it is not already there
- move the ticket to `Blocked` if the run is truly blocked and needs a human decision
- do not move a ticket to the next phase unless the user explicitly instructs that next phase or the project convention for that phase is already settled

By default, do use Linear to:

- read the assigned issue
- read linked or referenced issue context
- add a concise completion or blocker comment after the run

Preferred Linear comment shape:

- what changed or what was produced
- verification summary if relevant
- blocker summary if blocked
- Notion artifact link if one exists

## Context layer: Notion

Use Notion as the durable artifact surface for:

- design notes
- implementation plans
- review notes
- reusable project-level process context

Current Notion anchor page:

- `Orqestrate Project Overview`

For project-level build planning and working-method context, use the child page created for this repository’s build workflow.

Current Notion working page:

- `Orqestrate Build Plan and Working Mode`
- `https://www.notion.so/341944e75fa281b9a4fde328b5a0b20d`

For ticket-level work:

- prefer one durable Notion page per issue when the output is long-form or spans multiple phases
- update the same page across phases instead of scattering notes unless a split is clearly needed

By default, use Notion for:

- long-form artifacts
- durable reasoning and evidence
- links back to Linear and local docs

Do not use Notion for:

- high-frequency status tracking
- lease or lock state
- heartbeat-like execution state

## Local context

Local docs are part of the working context, not an afterthought.

Use:

- `docs/` for architecture, operating model, contracts, and durable repo-local knowledge
- repository files for implementation truth
- local docs to capture process decisions that future runs will need even if external tools are unavailable

When a decision is likely to matter again, prefer writing it into `docs/` rather than leaving it only in a ticket comment.

Quality and verification policy lives in:

- `docs/quality_policy.md`

Treat that document as normative for what "done" means in this repository.

## Phase behavior

### Design

When the user asks for `design`:

- read the Linear issue
- read relevant Notion and local context
- inspect the codebase
- produce or update a Notion design artifact
- leave a concise Linear comment linking to the artifact and summarizing the result

Do not implement code changes unless explicitly asked.

### Plan

When the user asks for `plan`:

- read the Linear issue and current artifact context
- produce an implementation plan with scope, risks, verification, and test strategy
- update the Notion artifact
- leave a concise Linear comment linking to the plan

Do not implement unless explicitly asked.

### Implement

When the user asks for `implement`:

- read the Linear issue
- read the current Notion artifact if one exists
- make the code changes locally
- run the required repo checks plus the strongest practical targeted verification
- add or update automated tests when behavior changes unless doing so is not practical yet
- update local docs when the change affects durable project knowledge
- update the Notion artifact with implementation summary and evidence
- leave a concise Linear comment with outcome and verification summary

If you do not add automated coverage for a behavior change, explain the gap explicitly in:

- the local summary
- the Notion artifact
- the Linear comment when concise enough

### Review

When the user asks for `review`:

- read the Linear issue
- inspect the code or PR state relevant to the review
- produce findings or an explicit no-findings result
- treat missing or weak verification as a first-class review concern
- update the Notion artifact with the review output
- leave a concise Linear comment summarizing findings

## Direct tool use policy

Default rule:

- local execution and local edits are agent-owned
- planning/context state transitions are orchestrator-owned

In this repository’s current human-orchestrated mode, direct Linear and Notion tool use is allowed for:

- reading assigned context
- writing long-form artifacts to Notion
- writing concise progress or outcome comments to Linear

Do not use Linear or Notion to silently invent workflow transitions.

## Working style

For each assigned ticket:

1. Read the ticket and the user’s explicit phase instruction.
2. Load relevant local docs and existing Notion context.
3. Do the assigned work in the repo.
4. Update the durable artifact surface:
   - Notion for long-form artifact
   - `docs/` for durable local project knowledge when appropriate
5. Add a concise Linear comment summarizing the run.
6. Return a local summary to the user with verification and remaining risks.

## Build strategy for this repository

Treat the current build as a validation of the future Orqestrate operating model.

That means:

- keep planning in Linear
- keep long-form context in Notion
- keep durable repo-local knowledge in `docs/`
- expect the user to orchestrate ticket order manually for now
- reflect the future architecture where possible, but do not pretend Orqestrate already exists

## If blocked

When blocked:

- identify the smallest concrete blocker
- record it in the local response
- update Notion if the blocker changes the durable artifact
- leave a concise Linear comment if the ticket now needs a human decision
- if appropriate, move the ticket to `Blocked`

Do not invent a new ticket flow on your own.

## Final rule

The user is currently the orchestrator.

Stay scoped to the explicitly assigned Linear ticket and phase.
Use Linear and Notion as the planning/context layers.
Use `docs/` as durable local memory.
Keep updates consistent across those surfaces without taking over workflow ownership from the user.
