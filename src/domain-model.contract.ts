import {
  RUN_STATUSES,
  WORK_PHASES,
} from "./index.js";
import type {
  ArtifactRecord,
  PromptEnvelope,
  PromptProvenanceRecord,
  PromptReplayContextRecord,
  ProviderError,
  RunLedgerRecord,
  RunRecord,
  RunSubmissionPayload,
  VerificationSummary,
  WorkItemRecord,
} from "./index.js";

const providerErrorFixture = {
  providerFamily: "planning",
  providerKind: "linear",
  code: "rate_limited",
  message: "Rate limit hit while refreshing the issue.",
  retryable: true,
  details: {
    retryAfterSec: 30,
    workItemId: "ORQ-16",
  },
} satisfies ProviderError;

const verificationFixture = {
  commands: ["npm run check"],
  passed: true,
  notes: "Compile-time contract fixtures passed.",
} satisfies VerificationSummary;

const workItemFixture = {
  id: "linear-issue-id",
  identifier: "ORQ-16",
  title: "Define canonical domain model and cross-layer contracts",
  description: "Implement the shared contract surface from docs/domain_model.md.",
  status: "implement",
  phase: "implement",
  priority: 1,
  labels: ["domain-model", "urgent"],
  url: "https://linear.app/orqestrate/issue/ORQ-16",
  parentId: "ORQ-6",
  dependencyIds: ["ORQ-17", "ORQ-18"],
  blockedByIds: [],
  blocksIds: ["ORQ-27", "ORQ-30"],
  artifactUrl: "https://www.notion.so/orq-16",
  updatedAt: "2026-04-14T00:00:00.000Z",
  createdAt: "2026-04-13T23:53:35.722Z",
  orchestration: {
    state: "running",
    owner: "orchestrator-1",
    runId: "run-2026-04-14-001",
    leaseUntil: "2026-04-14T01:00:00.000Z",
    reviewOutcome: "none",
    blockedReason: null,
    lastError: providerErrorFixture,
    attemptCount: 2,
  },
} satisfies WorkItemRecord;

const artifactFixture = {
  artifactId: "notion-page-id",
  workItemId: workItemFixture.id,
  title: "ORQ-16 - Canonical Domain Model and Cross-Layer Contracts",
  phase: "implement",
  state: "ready",
  url: workItemFixture.artifactUrl,
  summary: "Canonical contract module landed in code.",
  designReady: true,
  planReady: true,
  implementationNotesPresent: true,
  reviewSummaryPresent: false,
  verificationEvidencePresent: true,
  updatedAt: "2026-04-14T01:00:00.000Z",
  createdAt: "2026-04-14T00:52:00.000Z",
} satisfies ArtifactRecord;

const promptFixture = {
  contractId: "orqestrate/implement/v1",
  systemPrompt: "Stay scoped to the assigned ticket and phase.",
  userPrompt: "Implement ORQ-16.",
  attachments: [
    {
      kind: "artifact_url",
      value: artifactFixture.url ?? "https://www.notion.so/orq-16",
      label: "Issue artifact",
    },
  ],
  sources: [
    {
      kind: "base_pack",
      ref: "builtin://implement",
    },
    {
      kind: "phase_prompt",
      ref: "builtin://implement-phase",
    },
    {
      kind: "artifact",
      ref: artifactFixture.artifactId,
    },
  ],
  digests: {
    system: "sha256-system",
    user: "sha256-user",
  },
} satisfies PromptEnvelope;

const promptProvenanceFixture = {
  selection: {
    promptPackName: "default",
    capabilityNames: ["github-review"],
    organizationOverlayNames: ["org-reviewer"],
    projectOverlayNames: ["webapp-reviewer"],
    experimentName: "reviewer-v2",
  },
  sources: [
    {
      kind: "base_pack",
      ref: "prompt-pack:default/base/system.md",
      digest: "sha256-base-pack",
    },
    {
      kind: "role_prompt",
      ref: "prompt-pack:default/roles/review.md",
      digest: "sha256-role",
    },
  ],
  rendered: {
    systemPromptLength: 42,
    userPromptLength: 17,
    attachmentKinds: ["artifact_url"],
    attachmentCount: 1,
  },
} satisfies PromptProvenanceRecord;

const runRecordFixture = {
  runId: "run-2026-04-14-001",
  workItemId: workItemFixture.id,
  workItemIdentifier: workItemFixture.identifier,
  phase: "implement",
  provider: "codex",
  status: "running",
  repoRoot: "/Users/kimballhill/.codex/worktrees/ed88/orqestrate",
  workspace: {
    mode: "ephemeral_worktree",
    workingDirHint: "/Users/kimballhill/.codex/worktrees/ed88/orqestrate",
    workingDir: "/Users/kimballhill/.codex/worktrees/ed88/orqestrate",
    allocationId: "alloc-001",
    baseRef: "main",
    branchName: "hillkimball/orq-16-define-canonical-domain-model-and-cross-layer-contracts",
  },
  artifactUrl: artifactFixture.url,
  requestedBy: "Kimball Hill",
  grantedCapabilities: ["github.read_pr", "github.create_pr"],
  promptContractId: promptFixture.contractId,
  promptDigests: promptFixture.digests,
  promptProvenance: promptProvenanceFixture,
  limits: {
    maxWallTimeSec: 5400,
    idleTimeoutSec: 300,
    bootstrapTimeoutSec: 120,
  },
  outcome: {
    code: null,
    exitCode: null,
    summary: null,
    verification: verificationFixture,
    error: null,
  },
  createdAt: "2026-04-14T00:58:00.000Z",
  admittedAt: "2026-04-14T00:58:05.000Z",
  startedAt: "2026-04-14T00:58:15.000Z",
  completedAt: null,
  lastHeartbeatAt: "2026-04-14T00:59:30.000Z",
} satisfies RunRecord;

const promptReplayContextFixture = {
  runId: runRecordFixture.runId,
  workItem: {
    id: workItemFixture.id,
    identifier: workItemFixture.identifier,
    title: workItemFixture.title,
    description: workItemFixture.description,
    labels: workItemFixture.labels,
    url: workItemFixture.url,
  },
  artifact: {
    artifactId: artifactFixture.artifactId,
    url: artifactFixture.url,
    summary: artifactFixture.summary,
  },
  workspace: {
    repoRoot: runRecordFixture.repoRoot,
    workingDir: runRecordFixture.workspace.workingDirHint,
    mode: runRecordFixture.workspace.mode,
    assignedBranch: runRecordFixture.workspace.branchName,
    baseBranch: runRecordFixture.workspace.baseRef,
    pullRequestUrl: "https://github.com/kimballh/orqestrate/pull/16",
    pullRequestMode: "draft",
    writeScope: "repo",
  },
  expectations: {
    expectedOutputs: ["update artifact", "run verification"],
    verificationRequired: true,
    requiredRepoChecks: ["npm run check"],
    testExpectations: "Add targeted coverage when behavior changes.",
  },
  operatorNote: "Stay scoped to ORQ-16.",
  additionalContext: "Local docs reviewed before implementation.",
  attachments: [
    {
      kind: "text",
      value: "Review docs/domain_model.md before editing.",
      label: "Reminder",
    },
  ],
} satisfies PromptReplayContextRecord;

const runLedgerFixture = {
  runId: runRecordFixture.runId,
  workItemId: workItemFixture.id,
  artifactId: artifactFixture.artifactId,
  phase: "implement",
  status: "completed",
  summary: "Shared domain model contract exported from the package entrypoint.",
  verification: verificationFixture,
  error: null,
  startedAt: runRecordFixture.startedAt,
  endedAt: "2026-04-14T01:02:00.000Z",
  url: artifactFixture.url,
  updatedAt: "2026-04-14T01:02:00.000Z",
} satisfies RunLedgerRecord;

const runSubmissionFixture = {
  runId: runRecordFixture.runId,
  phase: "implement",
  workItem: {
    id: workItemFixture.id,
    identifier: workItemFixture.identifier,
    title: workItemFixture.title,
    description: workItemFixture.description,
    labels: workItemFixture.labels,
    url: workItemFixture.url,
  },
  artifact: {
    artifactId: artifactFixture.artifactId,
    url: artifactFixture.url,
    summary: artifactFixture.summary,
  },
  provider: "codex",
  workspace: {
    repoRoot: runRecordFixture.repoRoot,
    mode: runRecordFixture.workspace.mode,
    workingDirHint: runRecordFixture.workspace.workingDirHint,
    baseRef: runRecordFixture.workspace.baseRef,
    assignedBranch: runRecordFixture.workspace.branchName,
    pullRequestUrl: "https://github.com/kimballh/orqestrate/pull/16",
    pullRequestMode: "draft",
    writeScope: "repo",
  },
  prompt: promptFixture,
  grantedCapabilities: runRecordFixture.grantedCapabilities,
  promptProvenance: promptProvenanceFixture,
  promptReplayContext: promptReplayContextFixture,
  limits: runRecordFixture.limits,
  requestedBy: runRecordFixture.requestedBy,
} satisfies RunSubmissionPayload;

void WORK_PHASES;
void RUN_STATUSES;
void workItemFixture;
void artifactFixture;
void promptFixture;
void runRecordFixture;
void runLedgerFixture;
void runSubmissionFixture;
