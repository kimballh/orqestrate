# Working Mode

This document defines the current way of working for building Orqestrate before Orqestrate itself exists.

## 1. Current mode

Current mode is:

- human-orchestrated
- single-agent local execution
- Linear for planning
- Notion for long-form context
- `docs/` for durable repo-local context during implementation and dedicated documentation work

The user acts as the orchestrator and manually chooses which ticket and which phase to run next.

## 2. Source-of-truth split

| Concern | Current authority |
| --- | --- |
| Ticket identity and dependency order | Linear |
| Normal active phase signal | Linear status |
| Tiebreaker for ambiguous or exceptional runs | User instruction |
| Long-form design / plan / review artifacts | Notion |
| Durable repo-local implementation knowledge | `docs/` |
| Live process/session state | Codex local session |

Current preferred Linear statuses:

- `Backlog`
- `Design`
- `Plan`
- `Implement`
- `Review`
- `Blocked`
- `Done`
- `Canceled`

## 3. Linear usage

Linear team:

- `Orqestrate`

Linear project:

- `Orqestrate Build`
- `https://linear.app/orqestrate/project/orqestrate-build-374b99442159`

Use Linear for:

- the build ticket queue
- dependency encoding between tickets
- normal phase signaling through status
- concise run summaries
- blocking questions that should remain attached to the ticket

Working rule:

- normally, the ticket status should match the phase you want run next
- the user’s explicit instruction is the tiebreaker if there is a mismatch
- `Blocked` is not actionable unless explicitly chosen for investigation or unblock work
- `Backlog` is not ready for execution unless explicitly selected

## 4. Notion usage

Use Notion for:

- project-level build planning
- issue-level design and planning artifacts
- review notes
- implementation evidence when the output is longer than a short comment

Parent page:

- `Orqestrate Project Overview`

Project-level child page:

- `Orqestrate Build Plan and Working Mode`
- `https://www.notion.so/341944e75fa281b9a4fde328b5a0b20d`

## 5. Local docs usage

Use `docs/` for:

- architecture
- contracts
- operating model
- prompt model
- durable implementation decisions

If something will matter again even when external tools are unavailable, it belongs in `docs/`.

For the current ticket workflow:

- `design` and `plan` should normally update Notion artifacts and Linear comments, not repo-tracked docs
- repo-tracked docs should normally be updated during `implement` or through dedicated documentation tickets

## 6. Per-ticket execution flow

For each run:

1. User provides `ORQ-XXX` plus explicit phase instruction.
2. Read the Linear ticket.
3. Read relevant Notion artifact and local docs.
4. Perform the assigned work.
5. Update the durable artifact:
   - Notion for long-form artifact
   - `docs/` if repo-level knowledge changed during implementation or explicit documentation work
6. Keep the Linear status aligned with the assigned phase or blocker outcome when appropriate.
7. Add a concise Linear comment.
8. Return a local summary with verification and remaining risks.

### 6.1 Phase and workspace policy

`Design`

- should be branchless by default
- should not modify repo-tracked files
- should not create commits or pull requests
- should write its artifact to Notion and summarize in Linear

`Plan`

- should be branchless by default
- should not modify repo-tracked files
- should not create commits or pull requests
- should write its artifact to Notion and summarize in Linear

`Implement`

- should run in a dedicated worktree or branch-backed workspace
- should treat the current checked-out branch as the assigned branch unless the user says otherwise
- should not invent a second feature branch for the same ticket
- should commit the completed implementation
- should push the branch
- should create a pull request if one does not already exist

`Review`

- should review the branch or PR produced by implementation
- should be read-only by default unless the user explicitly asks for rework

## 7. Build streams

The full build should be planned around these streams:

1. `Core types, config, and provider registry`
2. `Prompt system and prompt customization`
3. `Local-files planning and context providers`
4. `Linear planning backend`
5. `Notion context backend`
6. `Runtime daemon and PTY supervision`
7. `Orchestrator loop and run dispatch`
8. `GitHub collaboration capability model`
9. `Prompt tooling, replay, and diagnostics`
10. `Integration tests and local-first developer UX`

These streams have now been turned into a concrete Linear backlog under `Orqestrate Build`.

Current issue map:

- parent stream issues: `ORQ-6` through `ORQ-15`
- child execution issues: `ORQ-16` through `ORQ-52`
- long-form backlog snapshot: `https://www.notion.so/341944e75fa28180a4b9c0cfabc950d4`

## 8. Ticket authoring guidance

Good tickets for the current mode:

- have one clear phase objective
- link to relevant docs or artifact pages
- call out blockers or dependencies explicitly
- are small enough for one focused Codex run

If a ticket cannot run in parallel with another ticket, encode that dependency in Linear.

## 9. What this mode is validating

By working this way before Orqestrate exists, we are testing:

- whether Linear is a workable planning surface
- whether Notion is a workable context surface
- whether prompt and artifact contracts are usable in practice
- whether the human-orchestrated version feels close to the intended automated version

This is useful validation, not just temporary process overhead.
