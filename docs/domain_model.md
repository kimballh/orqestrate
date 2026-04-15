# Canonical Domain Model

This document freezes the first shared internal contract for Orqestrate.

It is the design output for `ORQ-16` and the canonical source of truth for:

- shared record names across planning, context, orchestrator, and runtime layers
- enum semantics for planning state, execution phase, and runtime state
- authority boundaries between the orchestrator, runtime daemon, and agent
- serialization rules for config resolution, prompt assembly, and run submission

The goal is to let downstream tickets depend on stable type names instead of prose scattered across multiple docs.

## 1. Core decisions

1. Planning status, execution phase, orchestration state, and runtime status are separate dimensions.
2. Provider-native payloads stop at the adapter boundary. Internal services exchange canonical records.
3. `WorkItemRecord`, `ArtifactRecord`, `RunRecord`, and `RunLedgerRecord` are the required shared records for v1.
4. The orchestrator owns prompt assembly and run submission. The runtime receives a normalized payload and never re-reads planning or context systems.
5. The agent owns local execution and verification inside the workspace, but does not own global workflow mutation by default.

## 2. Vocabulary resolution

The canonical planning vocabulary for the initial MVP uses the Linear workflow statuses:

- `Backlog`
- `Design`
- `Plan`
- `Implement`
- `Review`
- `Blocked`
- `Done`
- `Canceled`

Some older draft docs still reference pre-v1 wording like `Needs Design`, `Needs Plan`, `Ready`, `In Progress`, `In Review`, or `Ready to Merge`.

For the first concrete contract, the Linear MVP vocabulary wins.

Canonical planning status values are:

```ts
export type WorkItemStatus =
  | "backlog"
  | "design"
  | "plan"
  | "implement"
  | "review"
  | "blocked"
  | "done"
  | "canceled";
```

Legacy wording should be treated as pre-v1 draft language and mapped as follows:

| Legacy wording | Canonical status |
| --- | --- |
| `Needs Design` | `design` |
| `Needs Plan` | `plan` |
| `Ready` | `implement` |
| `In Progress` | `implement` |
| `In Review` | `review` |
| `Ready to Merge` | no initial status mapping; keep `merge` as a reserved future phase |

Important normalization rule:

- use American English `canceled` consistently across planning and runtime contracts
- treat older `cancelled` spellings as draft wording to migrate away from

## 3. Canonical enums

These are the enums downstream tickets should depend on first.

```ts
export type WorkPhase =
  | "design"
  | "plan"
  | "implement"
  | "review"
  | "merge";

export type WorkPhaseOrNone = WorkPhase | "none";

export type WorkItemStatus =
  | "backlog"
  | "design"
  | "plan"
  | "implement"
  | "review"
  | "blocked"
  | "done"
  | "canceled";

export type OrchestrationState =
  | "idle"
  | "queued"
  | "claimed"
  | "running"
  | "waiting_human"
  | "failed"
  | "completed";

export type RunStatus =
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

export type ArtifactState =
  | "missing"
  | "draft"
  | "ready"
  | "archived";

export type ReviewOutcome =
  | "none"
  | "changes_requested"
  | "approved";

export type WorkspaceMode =
  | "shared_readonly"
  | "ephemeral_worktree";

export type ProviderFamily =
  | "planning"
  | "context"
  | "runtime";

export type AgentProvider =
  | "codex"
  | "claude";

export type ProviderErrorCode =
  | "auth_missing"
  | "auth_invalid"
  | "permission_denied"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "validation"
  | "timeout"
  | "transport"
  | "unavailable"
  | "unsupported"
  | "unknown";
```

### Enum intent

- `WorkItemStatus` is the normalized planning-surface status.
- `WorkPhase` is the execution contract the orchestrator and agent reason about.
- `OrchestrationState` is coarse machine ownership state persisted on the planning surface.
- `RunStatus` is runtime-only session state persisted by the runtime daemon.
- `ArtifactState` is lightweight completeness state for the durable artifact surface.

Do not collapse these into one field.

## 4. Canonical shared records

### 4.1 `ProviderError`

`ProviderError` is the shared error envelope used across planning adapters, context adapters, the orchestrator, and runtime result surfaces.

```ts
export type ProviderError = {
  providerFamily: ProviderFamily;
  providerKind: string;
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, string | number | boolean | null> | null;
};
```

Rules:

- `providerKind` is the concrete adapter or runtime name like `linear`, `notion`, `local_files`, `codex`, or `claude`
- `message` is human-readable and safe to surface in summaries
- `details` stays compact and structured; no raw provider payload dumps

### 4.2 `VerificationSummary`

```ts
export type VerificationSummary = {
  commands: string[];
  passed: boolean;
  notes?: string | null;
};
```

This is reused by `RunRecord`, `RunLedgerRecord`, and the agent result contract.

### 4.3 `WorkItemRecord`

`WorkItemRecord` is the canonical planning object returned by planning backends and consumed by the orchestrator.

```ts
export type WorkItemRecord = {
  id: string;
  identifier?: string | null;
  title: string;
  description?: string | null;
  status: WorkItemStatus;
  phase: WorkPhaseOrNone;
  priority?: number | null;
  labels: string[];
  url?: string | null;
  parentId?: string | null;
  dependencyIds: string[];
  blockedByIds: string[];
  blocksIds: string[];
  artifactUrl?: string | null;
  updatedAt: string;
  createdAt?: string | null;
  orchestration: {
    state: OrchestrationState;
    owner?: string | null;
    runId?: string | null;
    leaseUntil?: string | null;
    reviewOutcome?: ReviewOutcome | null;
    blockedReason?: string | null;
    lastError?: ProviderError | null;
    attemptCount: number;
  };
};
```

Rules:

- `status` answers what humans see in the planning system
- `phase` answers what kind of work the next or current run is performing
- `phase = "none"` is valid for `backlog`, `done`, and `canceled` items
- `phase` should be preserved when `status = "blocked"` if the block happened mid-phase
- planning adapters may derive `phase` from provider-native status, but the orchestrator should treat the canonical `phase` as authoritative once emitted

### 4.4 `ArtifactRecord`

`ArtifactRecord` is the durable issue-level artifact handle returned by context backends.

```ts
export type ArtifactRecord = {
  artifactId: string;
  workItemId: string;
  title: string;
  phase: WorkPhaseOrNone;
  state: ArtifactState;
  url?: string | null;
  summary?: string | null;
  designReady: boolean;
  planReady: boolean;
  implementationNotesPresent: boolean;
  reviewSummaryPresent: boolean;
  verificationEvidencePresent: boolean;
  updatedAt: string;
  createdAt?: string | null;
};
```

Rules:

- one issue should have one durable primary artifact page in v1
- artifact completeness flags are advisory completeness checks, not workflow authority
- `phase` reflects the latest artifact phase that materially changed the page

### 4.5 `RunRecord`

`RunRecord` is the canonical current-state runtime record stored by the runtime daemon.

```ts
export type RunRecord = {
  runId: string;
  workItemId: string;
  workItemIdentifier?: string | null;
  phase: WorkPhase;
  provider: AgentProvider;
  status: RunStatus;
  repoRoot: string;
  workspace: {
    mode: WorkspaceMode;
    workingDirHint?: string | null;
    workingDir?: string | null;
    allocationId?: string | null;
    baseRef?: string | null;
    branchName?: string | null;
  };
  artifactUrl?: string | null;
  requestedBy?: string | null;
  promptContractId: string;
  promptDigests: {
    system?: string | null;
    user: string;
  };
  limits: {
    maxWallTimeSec: number;
    idleTimeoutSec: number;
    bootstrapTimeoutSec: number;
  };
  outcome?: {
    code?: string | null;
    exitCode?: number | null;
    summary?: string | null;
    verification?: VerificationSummary | null;
    error?: ProviderError | null;
  } | null;
  createdAt: string;
  admittedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  lastHeartbeatAt?: string | null;
};
```

Rules:

- `RunRecord.status` is runtime authority and must not be overloaded with workflow meaning
- `promptContractId` identifies the prompt pack or contract used for the run
- the runtime stores prompt digests, not full prompt bodies, as part of the base run record
- full prompt text belongs in diagnostics or replay surfaces, not the canonical runtime row

### 4.6 `RunLedgerRecord`

`RunLedgerRecord` is the context-surface summary of a run and is meant for durable human inspection.

```ts
export type RunLedgerRecord = {
  runId: string;
  workItemId: string;
  artifactId?: string | null;
  phase: WorkPhase;
  status: RunStatus;
  summary?: string | null;
  verification?: VerificationSummary | null;
  error?: ProviderError | null;
  startedAt?: string | null;
  endedAt?: string | null;
  url?: string | null;
  updatedAt: string;
};
```

Rules:

- this is append-only in normal operation
- it is human-readable evidence, not the runtime system of record
- `status` may mirror runtime state, but write ordering still flows through the orchestrator

## 5. Authority boundaries

The system should keep one authority per state dimension.

| Concern | Authority | Not authoritative |
| --- | --- | --- |
| provider-native ticket and artifact translation | planning/context backends | orchestrator business logic |
| phase selection and workflow transitions | orchestrator | runtime daemon |
| prompt assembly and run submission payload | orchestrator | runtime daemon |
| run admission, liveness, and terminal session state | runtime daemon | planning backend |
| local edits, verification commands, and run summary content | agent | orchestrator queue logic |
| durable artifact body and run ledger persistence | context backend via orchestrator | runtime daemon direct writes |

Operational rule:

- agents may read planning or context systems when the run contract allows it
- orchestrator-owned writes remain the default

## 6. Serialization rules

### 6.1 Config resolution

Config moves through three layers:

1. raw TOML parse
2. validated resolved profile
3. run-scoped derived payload

Rules:

- raw config should stay local to config loading and provider instantiation
- environment variable references must be resolved before a provider instance is used
- secrets and raw provider credentials must never be copied into `RunRecord`, `RunLedgerRecord`, or artifact pages
- downstream code should pass provider instance names and resolved non-secret settings, not raw config blobs

### 6.2 Prompt assembly

Prompt assembly is an orchestrator concern and should produce a normalized envelope.

```ts
export type PromptAttachment = {
  kind: "artifact_url" | "planning_url" | "file_path" | "text";
  value: string;
  label?: string | null;
};

export type PromptSourceRef = {
  kind:
    | "base_pack"
    | "invariant"
    | "role_prompt"
    | "phase_prompt"
    | "capability"
    | "overlay"
    | "experiment"
    | "artifact"
    | "operator_note"
    | "system_generated";
  ref: string;
};

export type PromptEnvelope = {
  contractId: string;
  systemPrompt?: string | null;
  userPrompt: string;
  attachments: PromptAttachment[];
  sources: PromptSourceRef[];
  digests: {
    system?: string | null;
    user: string;
  };
};
```

Rules:

- prompt assembly happens before runtime submission
- `contractId` and digests are stable identifiers downstream systems can persist safely
- attachments are typed references, not unstructured prose
- prompt source refs should be symbolic and portable, such as `prompt-pack:default/roles/implement.md`, not absolute filesystem paths
- runtime providers must not infer prompt structure by scraping human-readable summaries

### 6.3 Run submission payload

The runtime boundary is a normalized submission payload, not direct access to planning or context systems.

```ts
export type RunSubmissionPayload = {
  runId: string;
  phase: WorkPhase;
  workItem: Pick<
    WorkItemRecord,
    "id" | "identifier" | "title" | "description" | "labels" | "url"
  >;
  artifact?: Pick<ArtifactRecord, "artifactId" | "url" | "summary"> | null;
  provider: AgentProvider;
  workspace: {
    repoRoot: string;
    mode: WorkspaceMode;
    workingDirHint?: string | null;
    baseRef?: string | null;
  };
  prompt: PromptEnvelope;
  limits: {
    maxWallTimeSec: number;
    idleTimeoutSec: number;
    bootstrapTimeoutSec: number;
  };
  requestedBy?: string | null;
};
```

Rules:

- runtime submission must be self-contained for one run
- `phase` is explicit on the payload and must never be inferred by the runtime from planning status text
- runtime should not need to query Linear, Notion, or `config.toml` to execute a run
- all timestamps crossing process boundaries should be ISO 8601 UTC strings
- enums serialize as lower-case ASCII strings
- optional nullable fields should use `null` only when the distinction between omitted and explicitly empty matters

## 7. Implications for downstream tickets

- `ORQ-17` should serialize config into resolved provider/profile objects without leaking secrets downstream
- `ORQ-18` should use `ProviderFamily` plus discriminated provider kinds to load adapters
- `ORQ-19` and `ORQ-20` should produce `PromptEnvelope` and `contractId`/digest metadata
- `ORQ-27` should map Linear issues into `WorkItemRecord`
- `ORQ-30` and `ORQ-31` should map Notion pages and run rows into `ArtifactRecord` and `RunLedgerRecord`
- `ORQ-32` and `ORQ-36` should implement `RunRecord`, `RunStatus`, and `RunSubmissionPayload`
- `ORQ-41` should extend capability modeling without redefining the core records above

## 8. Follow-up alignment

This document resolves the contract direction for v1, but several older docs still use draft vocabulary.

Future cleanup should align:

- [linear_model.md](./linear_model.md)
- [orchestrator.md](./orchestrator.md)
- [runtime_api.md](./runtime_api.md)
- [runtime_schema.md](./runtime_schema.md)

to the canonical types and spellings defined here.
