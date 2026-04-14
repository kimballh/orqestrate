# Agent Contract

This document defines the boundary between:

- the `code agent`
- the `orchestrator`
- the `runtime daemon`

This is the missing contract that determines what the agent must understand about Orqestrate and what should be invisible to it.

## 1. Main recommendation

Agents should understand the task they were assigned, the workspace they are operating in, and the output contract they must satisfy.

Agents should not understand Orqestrate’s global coordination model in detail.

That means:

- the agent is aware that it is running inside a managed harness
- the agent is given structured task context and output expectations
- the agent is not responsible for workflow state transitions, leases, queueing, scheduling, or provider plumbing

This keeps agents narrow and makes them replaceable.

## 2. Responsibility split

### 2.1 Orchestrator owns

- work item selection
- phase resolution
- claim and lease management
- planning backend reads and writes
- context backend reads and writes
- choosing the runtime provider (`codex`, `claude`, later others)
- deciding when a run is retryable, blocked, or terminal
- deciding what human-facing workflow status should change

### 2.2 Runtime daemon owns

- session launch
- PTY supervision
- concurrency limits
- workspace allocation
- liveness detection
- interrupt and cancel delivery
- run event persistence
- normalized runtime issue detection

### 2.3 Code agent owns

- understanding the assigned task
- inspecting the provided codebase and local files
- using the provided tools correctly
- making the requested code or document changes
- running verification steps inside its assigned environment
- reporting useful progress, blockers, and outcome summaries

The agent owns execution inside the run, not orchestration across runs.

## 3. The core rule

The agent should behave like a scoped worker with strong local autonomy and weak global authority.

In practical terms:

- strong local autonomy: the agent can inspect, edit, test, and summarize within the assigned workspace
- weak global authority: the agent cannot decide that a ticket is now `Done`, reclaim work, reassign itself, or change the active backend profile

## 4. What the agent should know

The agent should receive a structured run context at start.

Recommended shape:

```ts
type AgentRunContext = {
  runId: string;
  workItem: {
    id: string;
    identifier?: string | null;
    title: string;
    description?: string | null;
    phase: "design" | "plan" | "implement" | "review" | "merge";
    labels: string[];
    url?: string | null;
  };
  artifact: {
    url?: string | null;
    summary?: string | null;
  } | null;
  workspace: {
    repoRoot: string;
    workingDir: string;
    mode: "shared_readonly" | "ephemeral_worktree";
  };
  execution: {
    provider: "codex" | "claude";
    maxWallTimeSec: number;
    idleTimeoutSec: number;
  };
  contract: {
    taskType: "design" | "plan" | "implement" | "review" | "merge";
    expectedOutputs: string[];
    verificationRequired: boolean;
    writeScope?: string[] | null;
  };
};
```

This is enough for the agent to do good work without understanding the whole system.

## 5. What the agent should not need to know

The agent should not need to know:

- whether the planning backend is Linear, Asana, or local files
- whether the context backend is Notion, Google Drive, or local files
- how webhook ingestion works
- how queue dedupe works
- how leases are persisted
- how many runtime daemons exist
- how admission control works
- what config profile is active globally

Those are harness concerns, not worker concerns.

## 6. What the agent can assume

The agent should be allowed to assume:

- the run was explicitly assigned
- the workspace has already been prepared
- the task phase is authoritative for this run
- any context the harness wanted to provide has already been loaded or referenced
- the runtime will handle logging, interrupts, cancellation, and liveness
- the orchestrator will decide what happens after the run completes

Those assumptions are important. Without them, the agent will try to compensate for system responsibilities it should not own.

## 7. What the agent should produce

The agent should produce outputs in a normalized result contract instead of trying to mutate provider systems directly.

Recommended shape:

```ts
type AgentResult = {
  status: "completed" | "failed" | "waiting_human";
  summary: string;
  details?: string | null;
  requestedHumanInput?: {
    question: string;
    blockingReason: string;
  } | null;
  verification?: {
    commands: string[];
    passed: boolean;
    notes?: string | null;
  } | null;
  artifacts?: {
    designMarkdown?: string | null;
    planMarkdown?: string | null;
    reviewMarkdown?: string | null;
    evidenceMarkdown?: string | null;
  } | null;
};
```

The orchestrator and context backend can then decide how to persist that result.

## 8. Tool access policy

The agent should primarily operate on:

- local files in its assigned workspace
- local shell commands
- runtime-provided structured task/context data

Tool access to planning or context systems should be a deliberate choice, not a default assumption.

### 8.1 Default policy

By default, the agent should not directly mutate:

- Linear
- Asana
- Notion
- Google Drive

The orchestrator should own those writes after interpreting the result.

This prevents:

- duplicate state transitions
- provider-specific prompt logic leaking into agents
- broken invariants between the planning and context layers

### 8.2 Acceptable direct tool calls

Agents may still use provider tools in narrow cases if explicitly allowed by the run contract.

Examples:

- read-only fetch of a referenced artifact page
- read-only fetch of a ticket description that was not preloaded
- writing a review comment directly only if the phase contract says comments are first-class output

But the default should remain:

- agent returns results
- orchestrator persists results

## 9. Why the agent should not own provider writes by default

If the agent writes to planning/context systems directly, several problems appear:

- the agent prompt becomes provider-specific
- local-files mode behaves differently than SaaS mode
- retries become harder because side effects may already have happened
- the orchestrator loses control of write ordering and consistency

That is exactly what we want to avoid.

The core should remain:

- agent acts locally
- orchestrator commits globally

## 10. Exception cases

There are a few cases where direct provider access from the agent may still be justified.

### 10.1 Read-only enrichment

If the agent needs more context than the orchestrator preloaded, it may read:

- artifact pages
- attached documents
- referenced files

This is fine as long as those reads are explicit and bounded.

### 10.2 Human-facing review comment generation

In some review flows, the run contract may allow the agent to create a provider-native comment draft directly.

Even then, prefer:

- draft content as output artifact
- orchestrator decides whether and where to post it

### 10.3 Provider-driven investigation phases

If a future non-code phase is mostly about triaging provider state, a specialized agent contract may allow more direct reads. That should be the exception, not the base code-agent contract.

## 11. Agent phases and expected behavior

The agent contract should vary by phase, but only in task semantics, not in system authority.

### 11.1 Design

Agent should:

- inspect code and context
- produce design notes
- surface open questions and risks

Agent should not:

- modify repo-tracked files by default
- create commits, branches, or pull requests
- transition the work item to the next workflow state

### 11.2 Plan

Agent should:

- produce an implementation plan
- outline verification
- identify scope and non-goals

Agent should not:

- modify repo-tracked files by default
- create commits, branches, or pull requests
- claim implementation has started

### 11.3 Implement

Agent should:

- change code
- run verification
- summarize what changed
- commit and push the assigned branch when the run contract authorizes branch-backed delivery
- create or update the pull request when the run contract authorizes GitHub delivery

Agent should not:

- invent a second feature branch when an assigned branch already exists
- mark the ticket `Review` directly in the planning backend unless explicitly delegated to do so by the orchestrator

### 11.4 Review

Agent should:

- inspect changes
- produce findings or approval summary

Agent should not:

- change repo contents by default unless the run is explicitly a rework run
- directly transition the work item to `Done` or invent a merge handoff by default

### 11.5 Merge

Agent should:

- perform merge-related checks or instructions if allowed

Agent should not:

- own release-management policy unless that is explicitly part of the phase contract

## 12. Prompt contract

The agent should receive a stable system-level instruction that makes the boundary explicit.

Recommended prompt rules:

- you are assigned one scoped run
- your job is to complete the assigned phase in the provided workspace
- do not mutate global workflow state unless the run explicitly authorizes it
- if the run includes an assigned branch, do not create a second one
- return structured outputs and verification evidence
- if blocked, ask for concrete human input instead of inventing policy

This should live in the runtime/provider prompt scaffolding, not be reinvented per task.

## 13. Human input handling

The agent may determine that a human decision is required.

When that happens, the agent should return:

- the exact question
- why it blocks progress
- the smallest decision needed to proceed

The agent should not:

- self-reassign
- change queue priority
- silently abandon the run

The orchestrator and runtime own the waiting-state machinery.

## 14. Retry and resumability

The agent should be written as if a run may be restarted.

That means:

- output should be reconstructable from workspace state
- summaries should be explicit
- verification should be rerunnable
- the agent should not assume long-lived hidden memory across runs

The orchestrator owns retry policy.
The agent owns producing enough local evidence that retry is safe and understandable.

## 15. The cleanest default model

The cleanest default model for Orqestrate is:

- planning and context systems are abstracted behind backends
- the orchestrator reads and writes those systems
- the runtime daemon manages agent execution
- the code agent works inside the workspace and returns structured results

This keeps the code agent portable across:

- `linear + notion`
- `linear + local_files`
- `local_files + local_files`
- future provider combinations

without rewriting the agent contract.

## 16. Practical recommendation

For v1, I would lock in these rules:

1. Agents are provider-agnostic by default.
2. Agents operate primarily on local files and shell tools.
3. Agents do not write planning/context systems directly unless explicitly authorized by the run contract.
4. Agents return structured results, summaries, and verification evidence.
5. Orchestrator persists global side effects.
6. Runtime daemon handles execution concerns only.

That is the simplest model that stays flexible.
