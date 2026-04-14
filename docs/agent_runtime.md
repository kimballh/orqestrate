# Agent Runtime Service

This file defines the orchestrator-to-agent execution layer.

The recommendation is:

- do not let the Linear orchestrator talk to Codex CLI directly
- insert a standalone agent runtime service between them
- make that service provider-neutral so it can run `codex`, `claude`, or another CLI later

This is the clean boundary:

`Linear -> orchestrator -> agent runtime service -> provider CLI`

That keeps workflow policy separate from session supervision.

## 1. Why this should be a separate service

The Linear orchestrator should own:

- which issue to act on
- which phase to run
- whether the issue is claimable
- when to retry, block, or wait for a human

The agent runtime service should own:

- starting and stopping interactive CLI sessions
- limiting concurrent runs
- isolating runs from each other
- detecting launch failures, stuck sessions, and dead processes
- capturing logs, heartbeats, and terminal outcomes
- presenting a uniform contract back to the orchestrator

Those are different concerns.

If you combine them, the orchestrator becomes a fragile process supervisor. OMX avoids some of that by separating durable team state from the tmux transport/runtime layer. Your harness should keep that lesson and go one step further by making the runtime transport-agnostic.

## 2. Main design choice

Do not make `tmux` the core runtime.

Use a PTY-native supervisor as the core runtime, and treat `tmux` as an optional operator surface.

Recommended model:

- authoritative runtime state lives in the runtime service database
- each worker run gets its own PTY-backed session
- `tmux` is optional for attaching to a live session, debugging, or mirroring a PTY
- the runtime service is a host-local daemon with a local-only API surface

Why this is better than tmux-first:

- easier to run headless in a service environment
- easier to reason about process ownership and exit status
- easier to support multiple providers uniformly
- easier to capture structured stdout/stderr and heartbeat events
- easier to enforce concurrency and cancellation centrally

What tmux is still good at:

- local operator visibility
- manual debugging
- attaching to a live run when the automation looks suspicious

So the right stance is:

- PTY supervisor = required
- tmux mirror = optional

## 3. What to borrow from OMX

These OMX ideas are worth preserving:

- durable runtime state and transport state should not be the same thing
- provider selection should be a separate layer from session supervision
- launch arguments and provider-specific translation should live behind an adapter
- message delivery evidence is not the same thing as task completion

Relevant seams in OMX:

- [docs/contracts/team-runtime-state-contract.md](/Users/kimballhill/hardline/oh-my-codex/docs/contracts/team-runtime-state-contract.md)
- [src/team/state.ts](/Users/kimballhill/hardline/oh-my-codex/src/team/state.ts)
- [src/team/runtime.ts](/Users/kimballhill/hardline/oh-my-codex/src/team/runtime.ts)
- [src/team/runtime-cli.ts](/Users/kimballhill/hardline/oh-my-codex/src/team/runtime-cli.ts)
- [src/team/tmux-session.ts](/Users/kimballhill/hardline/oh-my-codex/src/team/tmux-session.ts)

The part to avoid inheriting is the assumption that pane lifecycle is the same as worker lifecycle.

## 4. Recommended architecture

### 4.1 Components

`orchestrator`
- submits a run request
- receives status/events/outcome

`agent runtime service`
- owns run queue
- owns concurrency limits
- owns provider session lifecycle
- owns runtime state store

`provider adapter`
- translates a generic run request into provider-specific command/env/prompt behavior

`session supervisor`
- launches PTY-backed provider sessions
- captures output and exit status
- sends input, interrupt, and cancel actions

`artifact bridge`
- publishes run summaries, errors, and evidence back to the orchestrator

### 4.2 Service boundary

The orchestrator should call the runtime service through a narrow API:

- `enqueue_run`
- `get_run`
- `list_runs`
- `cancel_run`
- `interrupt_run`
- `submit_human_input`
- `stream_run_events`

Do not let the orchestrator manage raw subprocesses.

## 5. Run model

One issue phase maps to one runtime run.

Suggested top-level run shape:

```ts
type AgentRun = {
  runId: string;
  workItemId: string;
  phase: "design" | "plan" | "implement" | "review" | "merge";
  provider: "codex" | "claude";
  status:
    | "queued"
    | "admitted"
    | "launching"
    | "bootstrapping"
    | "running"
    | "waiting_human"
    | "stopping"
    | "completed"
    | "failed"
    | "canceled"
    | "stale";
  workspace: {
    repoRoot: string;
    workingDir: string;
    branch?: string | null;
    worktreePath?: string | null;
  };
  leaseUntil: string | null;
  startedAt: string | null;
  completedAt: string | null;
  owner: string | null;
  promptContractId: string;
  artifactUrl?: string | null;
  lastHeartbeatAt: string | null;
  lastError?: string | null;
};
```

Important rule:

- run status is runtime state
- issue status is workflow state

Do not collapse them into one field.

## 6. Provider adapter contract

This is the key to supporting both Codex and Claude.

The runtime service should depend on a provider adapter interface, not on Codex-specific shell commands.

Suggested interface:

```ts
type ProviderAdapter = {
  name: "codex" | "claude";
  buildLaunchSpec(input: RunLaunchInput): {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  };
  detectReady(signal: SessionSnapshot): boolean;
  classifyOutput(event: OutputEvent): RuntimeSignal[];
  submitPrompt(session: LiveSession, prompt: string): Promise<void>;
  interrupt(session: LiveSession): Promise<void>;
  cancel(session: LiveSession): Promise<void>;
  collectOutcome(session: LiveSession): Promise<RunOutcome>;
};
```

The orchestrator should never know:

- which binary is launched
- which flags are provider-specific
- what text pattern means "ready"
- how to interrupt or cancel a session

OMX already has part of this idea in [src/team/tmux-session.ts](/Users/kimballhill/hardline/oh-my-codex/src/team/tmux-session.ts): `resolveTeamWorkerCli`, `resolveTeamWorkerCliPlan`, `translateWorkerLaunchArgsForCli`, and `buildWorkerProcessLaunchSpec`.

Lift that abstraction upward. Do not keep it trapped inside tmux code.

## 7. Session supervision

### 7.1 Recommended runtime mode

Run each provider session under a PTY-backed process supervisor.

That gives you:

- stdin injection
- terminal output capture
- readiness detection
- proper interrupt handling
- provider parity for interactive CLIs

### 7.2 PTY vs plain pipes

Prefer PTY over plain `spawn` pipes because these CLIs are interactive and often behave differently when they detect a TTY.

Good options:

- Node runtime with a PTY library
- Rust sidecar that exposes PTY control to the runtime service

Plain `spawn` with pipes is the wrong default for this problem.

### 7.3 Tmux integration mode

If you still want tmux, make it optional:

- `headless`: PTY only
- `mirrored`: PTY plus optional tmux mirror for operator attach
- `debug`: direct tmux-launched provider session for manual intervention

Only `headless` and `mirrored` should be used by automation.

## 8. Concurrency management

The runtime service, not the orchestrator, should enforce concurrency.

Recommended controls:

- global max concurrent runs
- per-provider max concurrent runs
- per-repository max concurrent runs
- optional per-phase caps

Suggested scheduler rules:

- `implement` consumes a full slot
- `design`, `plan`, and `review` can still consume full slots in v1 for simplicity
- only admit a new run when both a global slot and a provider slot are free

If you later need more sophistication, add weighted slots. Do not start there.

## 9. Workspace isolation

The runtime service should not run all sessions in one mutable working tree.

Recommended options:

- `single-worktree` for cheap read-only phases like design or review
- `ephemeral-worktree` for implementation runs

First-pass recommendation:

- design/plan/review can reuse one clean repo clone or safe shared workspace if they are read-only
- implement should run in an isolated branch/worktree

The runtime service should own workspace preparation and cleanup, then report the resulting paths back to the orchestrator.

## 10. Failure detection

This service needs stronger runtime detection than "process exists".

Detect at least these classes:

### 10.1 Launch failure

- binary missing
- invalid flags
- startup exit before ready

### 10.2 Bootstrap stall

- process is alive but never reaches ready state
- trust/permission prompt not dismissed
- provider opened in an unexpected mode

### 10.3 Runtime stall

- no output and no heartbeat past threshold
- repeated prompt without progress
- run exceeded max wall time

### 10.4 Provider-side request for human intervention

- explicit question to operator
- approval/permission request
- ambiguous repo state that needs a decision

### 10.5 Transport failure

- PTY broken
- process detached unexpectedly
- output stream corrupted or unreadable

The runtime service should classify these into a small normalized outcome set:

- `completed`
- `failed_retryable`
- `failed_terminal`
- `waiting_human`
- `canceled`
- `stale`

## 11. Heartbeats and health

Each run should emit heartbeats independent of raw terminal output.

Suggested heartbeat sources:

- bytes observed on stdout/stderr
- explicit prompt submission or provider action
- file-system activity in the assigned workspace
- periodic adapter probe if the provider supports it

Do not rely on output alone. Some runs are quiet while still progressing.

## 12. Event model

The runtime service should emit append-only events for each run.

Suggested event types:

- `run_enqueued`
- `slot_acquired`
- `workspace_prepared`
- `session_launch_started`
- `session_ready`
- `prompt_submitted`
- `heartbeat`
- `stdout_chunk`
- `warning`
- `waiting_human`
- `lease_extended`
- `completed`
- `failed`
- `canceled`

The orchestrator should consume summaries, not raw terminal tails, by default.

Raw output should still be persisted for debugging.

## 13. Orchestrator-to-runtime API

Suggested `enqueue_run` request:

```json
{
  "run_id": "run-2026-04-12-001",
  "issue_id": "issue-id",
  "phase": "implement",
  "provider": "codex",
  "workspace": {
    "repo_root": "/repo",
    "working_dir": "/repo",
    "worktree_mode": "ephemeral"
  },
  "prompt_spec": {
    "system_contract": "executor-v1",
    "user_prompt": "Implement the approved plan for issue LIN-123."
  },
  "limits": {
    "max_wall_time_sec": 5400,
    "idle_timeout_sec": 300
  },
  "metadata": {
    "linear_issue_identifier": "LIN-123",
    "artifact_url": "https://notion.so/..."
  }
}
```

Suggested `RunOutcome` back to the orchestrator:

```json
{
  "run_id": "run-2026-04-12-001",
  "status": "completed",
  "provider": "codex",
  "started_at": "2026-04-12T20:00:00.000Z",
  "completed_at": "2026-04-12T20:22:00.000Z",
  "summary": "Implemented API adapter and added tests.",
  "verification": {
    "commands": ["npm test -- agent-runtime"],
    "passed": true
  },
  "artifacts": {
    "log_url": "internal://runs/run-2026-04-12-001/log",
    "workspace_path": "/tmp/harness/run-2026-04-12-001"
  }
}
```

Keep that contract provider-neutral.

## 14. Provider neutrality

To support both Codex and Claude cleanly:

- normalize provider selection to one enum
- keep launch-arg translation provider-specific
- keep ready detection provider-specific
- keep interrupt/cancel behavior provider-specific
- keep orchestration states provider-neutral

This is exactly where OMX is already pointing:

- provider choice is separate
- launch translation is separate
- the problem is only that session supervision is still tmux-centric

Your service should preserve the first two and replace the third.

## 15. Recommended first implementation

If you want the most practical v1:

1. Build a standalone runtime service.
2. Use a PTY-backed supervisor as the default execution engine.
3. Support `codex` first through one provider adapter.
4. Keep `claude` as a second adapter using the same run contract.
5. Make tmux optional for attach/debug only.
6. Persist runtime state and append-only events in a small local database.
7. Let the Linear orchestrator treat the runtime service as an execution API, not a shell wrapper.

That gets you a durable execution layer without baking tmux assumptions into the harness.

## 16. Open design questions

- Should the runtime service expose HTTP, gRPC, or just a local durable queue plus worker process?
- Should workspaces be prepared by the runtime service or by the orchestrator?
- Do you want live token/output streaming back into Notion or only terminal summaries?
- Do you want tmux mirroring in v1, or only headless PTY sessions?
- Do you want one runtime instance per repo, or one shared runtime that multiplexes many repos?

## 17. Recommendation

The best design is:

- Linear orchestrator for workflow decisions
- standalone agent runtime service for provider execution
- PTY-native supervision as the default
- tmux as an optional operator/debug layer
- provider adapters for `codex` and `claude`

That is cleaner than a tmux-first design, easier to operate headlessly, and easier to extend later.

Concrete follow-on specs now live in:

- [runtime_api.md](./runtime_api.md)
- [runtime_schema.md](./runtime_schema.md)
