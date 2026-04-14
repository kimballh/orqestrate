# Provider Architecture

This file defines how planning and context integrations should be abstracted so the harness can support:

- `Linear` today
- `Asana` later
- `Notion` today
- `Google Drive` later
- fully local file-backed deployments from day one

## 1. Main recommendation

Do not build one giant "tool integration" base class.

Build two separate provider families:

- `PlanningBackend`
- `ContextBackend`

That split matches the actual responsibilities in the harness:

- planning backends own workflow objects, claims, and state transitions
- context backends own artifacts, document retrieval, and run-history context

Linear and Asana belong in the first family.
Notion and Google Drive belong in the second.
Local files should implement both.

## 2. Why two families instead of one

Planning systems and context stores have different contracts.

A planning system needs:

- actionable work-item listing
- claim/lease semantics
- workflow status updates
- comments or operator notes

A context store needs:

- artifact creation
- artifact updates
- context retrieval
- search or reference resolution
- run-history persistence

If you put those in one abstract class, every provider ends up with half-empty methods and the abstraction gets soft fast.

## 3. Internal canonical model

The harness should not use provider-native objects internally.

It should translate every provider response into canonical internal records.

Recommended internal types are frozen in [domain_model.md](./domain_model.md) and exported from `src/domain-model.ts`:

```ts
import type {
  ArtifactRecord,
  OrchestrationState,
  ProviderError,
  ReviewOutcome,
  RunLedgerRecord,
  RunStatus,
  WorkItemRecord,
  WorkItemStatus,
  WorkPhase,
  WorkPhaseOrNone,
} from "../src/domain-model.js";
```

These are the objects the orchestrator should reason about.

## 4. Planning backend contract

Use an abstract class for shared lifecycle and validation, but keep data contracts provider-neutral.

```ts
export abstract class PlanningBackend {
  abstract readonly kind: string;
  abstract validateConfig(): Promise<void>;
  abstract healthCheck(): Promise<{ ok: boolean; message?: string }>;

  abstract listActionableWorkItems(input: {
    phases?: WorkPhase[];
    statuses?: WorkItemStatus[];
    limit: number;
  }): Promise<WorkItemRecord[]>;

  abstract getWorkItem(id: string): Promise<WorkItemRecord | null>;

  abstract claimWorkItem(input: {
    id: string;
    phase: WorkPhase;
    owner: string;
    runId: string;
    leaseUntil: string;
  }): Promise<WorkItemRecord>;

  abstract markWorkItemRunning(input: {
    id: string;
    owner: string;
    runId: string;
    leaseUntil: string;
  }): Promise<WorkItemRecord>;

  abstract renewLease(input: {
    id: string;
    owner: string;
    runId: string;
    leaseUntil: string;
  }): Promise<WorkItemRecord>;

  abstract transitionWorkItem(input: {
    id: string;
    nextStatus: WorkItemStatus;
    nextPhase: WorkPhaseOrNone;
    state: OrchestrationState;
    reviewOutcome?: ReviewOutcome | null;
    blockedReason?: string | null;
    lastError?: ProviderError | null;
    runId?: string | null;
  }): Promise<WorkItemRecord>;

  abstract appendComment(input: {
    id: string;
    body: string;
  }): Promise<void>;

  abstract buildDeepLink(id: string): Promise<string | null>;
}
```

### Built-in planning backends

- `linear`
- `local_files`

### Future planning backends

- `asana`
- `jira`
- `github_projects`

## 5. Context backend contract

Context backends manage artifacts and run-history material.

```ts
export abstract class ContextBackend {
  abstract readonly kind: string;
  abstract validateConfig(): Promise<void>;
  abstract healthCheck(): Promise<{ ok: boolean; message?: string }>;

  abstract ensureArtifact(input: {
    workItem: WorkItemRecord;
  }): Promise<ArtifactRecord>;

  abstract getArtifactByWorkItemId(workItemId: string): Promise<ArtifactRecord | null>;

  abstract loadContextBundle(input: {
    workItem: WorkItemRecord;
    artifact?: ArtifactRecord | null;
    phase: WorkPhase;
  }): Promise<{
    artifact: ArtifactRecord | null;
    contextText: string;
    references: Array<{ kind: string; title: string; url?: string | null }>;
  }>;

  abstract writePhaseArtifact(input: {
    workItem: WorkItemRecord;
    artifact: ArtifactRecord;
    phase: WorkPhase;
    content: string;
    summary?: string | null;
  }): Promise<ArtifactRecord>;

  abstract createRunLedgerEntry(input: {
    runId: string;
    workItem: WorkItemRecord;
    phase: WorkPhase;
    status: RunStatus;
  }): Promise<RunLedgerRecord>;

  abstract finalizeRunLedgerEntry(input: {
    runId: string;
    status: RunStatus;
    summary?: string | null;
    error?: ProviderError | null;
  }): Promise<RunLedgerRecord>;

  abstract appendEvidence(input: {
    runId: string;
    workItemId: string;
    section: string;
    content: string;
  }): Promise<void>;
}
```

### Built-in context backends

- `notion`
- `local_files`

### Future context backends

- `google_drive`
- `confluence`
- `obsidian_vault`

## 6. Local files as first-class providers

Local files should not be a dev-only stub.

They should be real providers with the same contract quality as SaaS providers.

### 6.1 `local_files` planning backend

Recommended structure:

```text
.harness/
  planning/
    issues/
      ISSUE-001.json
      ISSUE-002.json
    comments/
      ISSUE-001.md
    index.json
```

Recommended `issues/*.json` shape:

```json
{
  "id": "ISSUE-001",
  "title": "Add runtime provider adapter registry",
  "description": "Implement provider registration for planning/context backends.",
  "status": "ready",
  "phase": "implement",
  "claim_state": "queued",
  "claim_owner": null,
  "run_id": null,
  "lease_until": null,
  "review_outcome": "none",
  "blocked_reason": null,
  "labels": ["backend"],
  "updated_at": "2026-04-13T00:00:00.000Z"
}
```

This gives you a fully local planning surface without inventing another schema later.

### 6.2 `local_files` context backend

Recommended structure:

```text
.harness/
  context/
    artifacts/
      ISSUE-001.md
    runs/
      run-2026-04-13-001.json
    evidence/
      run-2026-04-13-001.md
```

Recommended behavior:

- one Markdown artifact per work item
- one JSON run ledger file per run
- optional Markdown evidence appendices per run

This mirrors the Notion model closely enough that migration later stays simple.

## 7. Provider registry

The harness should resolve providers from a registry, not with `if provider == "linear"` logic spread around the codebase.

Recommended factory shape:

```ts
export type ProviderFactory<T> = (config: Record<string, unknown>) => T;

export type ProviderRegistry = {
  planning: Map<string, ProviderFactory<PlanningBackend>>;
  context: Map<string, ProviderFactory<ContextBackend>>;
};
```

Recommended built-in registrations:

- `planning.linear`
- `planning.local_files`
- `context.notion`
- `context.local_files`

Later:

- `planning.asana`
- `context.google_drive`

## 8. Wiring model

The orchestrator should never import `LinearPlanningBackend` directly.

It should receive:

- one active `PlanningBackend`
- one active `ContextBackend`

Everything else should come from configuration and provider registration.

```ts
export type HarnessWiring = {
  planning: PlanningBackend;
  context: ContextBackend;
};
```

That keeps deployments swappable:

- `linear + notion`
- `linear + local_files`
- `local_files + local_files`
- `asana + google_drive`

## 9. Config-driven provider selection

Use `config.toml`.

That is a good fit here because:

- humans can read and edit it
- it maps well to named provider instances and profiles
- it is already familiar in CLI/open-source tooling

Recommended approach:

- one global config format
- many named provider instances
- one or more profiles that select which planning/context backends are active

The config model is defined in [config_model.md](./config_model.md).

## 10. Implementation guidance

If we want this to age well as an open-source project:

- keep provider-native ids inside adapters
- keep canonical workflow types inside the core
- make `local_files` a first-class built-in provider
- validate provider configs at startup
- keep secrets out of `config.toml`; refer to env vars from config
- treat provider support as plugins, not forks of the orchestrator

## 11. Recommendation

The right shape is:

- two backend families, not one giant integration abstraction
- canonical internal records
- registry-based provider loading
- `config.toml` profiles that choose provider instances
- built-in `local_files` providers so the project can run entirely locally

That gives us flexibility without turning the core into provider-specific glue.
