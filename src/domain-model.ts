// Tuple-based enums give downstream code both runtime values and type-safe unions.
export const WORK_PHASES = [
  "design",
  "plan",
  "implement",
  "review",
  "merge",
] as const;

export type WorkPhase = (typeof WORK_PHASES)[number];

export const WORK_PHASES_OR_NONE = [
  "design",
  "plan",
  "implement",
  "review",
  "merge",
  "none",
] as const;

export type WorkPhaseOrNone = (typeof WORK_PHASES_OR_NONE)[number];

export const WORK_ITEM_STATUSES = [
  "backlog",
  "design",
  "plan",
  "implement",
  "review",
  "blocked",
  "done",
  "canceled",
] as const;

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export const ORCHESTRATION_STATES = [
  "idle",
  "queued",
  "claimed",
  "running",
  "waiting_human",
  "failed",
  "completed",
] as const;

export type OrchestrationState = (typeof ORCHESTRATION_STATES)[number];

export const RUN_STATUSES = [
  "queued",
  "admitted",
  "launching",
  "bootstrapping",
  "running",
  "waiting_human",
  "stopping",
  "completed",
  "failed",
  "canceled",
  "stale",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const ARTIFACT_STATES = [
  "missing",
  "draft",
  "ready",
  "archived",
] as const;

export type ArtifactState = (typeof ARTIFACT_STATES)[number];

export const REVIEW_OUTCOMES = [
  "none",
  "changes_requested",
  "approved",
] as const;

export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

export const WORKSPACE_MODES = [
  "shared_readonly",
  "ephemeral_worktree",
] as const;

export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export const PROVIDER_FAMILIES = [
  "planning",
  "context",
  "runtime",
] as const;

export type ProviderFamily = (typeof PROVIDER_FAMILIES)[number];

export const AGENT_PROVIDERS = ["codex", "claude"] as const;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export const PROVIDER_ERROR_CODES = [
  "auth_missing",
  "auth_invalid",
  "permission_denied",
  "not_found",
  "conflict",
  "rate_limited",
  "validation",
  "timeout",
  "transport",
  "unavailable",
  "unsupported",
  "unknown",
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export const PROMPT_ATTACHMENT_KINDS = [
  "artifact_url",
  "planning_url",
  "file_path",
  "text",
] as const;

export type PromptAttachmentKind = (typeof PROMPT_ATTACHMENT_KINDS)[number];

export const PROMPT_SOURCE_KINDS = [
  "base_pack",
  "invariant",
  "role_prompt",
  "phase_prompt",
  "capability",
  "overlay",
  "experiment",
  "artifact",
  "operator_note",
  "system_generated",
] as const;

export type PromptSourceKind = (typeof PROMPT_SOURCE_KINDS)[number];

type ProviderErrorDetailValue = string | number | boolean | null;
type ProviderErrorDetails = Record<string, ProviderErrorDetailValue>;

export type ProviderError = {
  providerFamily: ProviderFamily;
  providerKind: string;
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  details?: ProviderErrorDetails | null;
};

export type VerificationSummary = {
  commands: string[];
  passed: boolean;
  notes?: string | null;
};

export type WorkItemOrchestration = {
  state: OrchestrationState;
  owner?: string | null;
  runId?: string | null;
  leaseUntil?: string | null;
  reviewOutcome?: ReviewOutcome | null;
  blockedReason?: string | null;
  lastError?: ProviderError | null;
  attemptCount: number;
};

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
  orchestration: WorkItemOrchestration;
};

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

export type RunWorkspaceRecord = {
  mode: WorkspaceMode;
  workingDirHint?: string | null;
  workingDir?: string | null;
  allocationId?: string | null;
  baseRef?: string | null;
  branchName?: string | null;
};

export type RunOutcomeRecord = {
  code?: string | null;
  exitCode?: number | null;
  summary?: string | null;
  details?: string | null;
  verification?: VerificationSummary | null;
  requestedHumanInput?: string | null;
  reviewOutcome?: Exclude<ReviewOutcome, "none"> | null;
  artifactMarkdown?: string | null;
  error?: ProviderError | null;
};

export type RunRecord = {
  runId: string;
  workItemId: string;
  workItemIdentifier?: string | null;
  phase: WorkPhase;
  provider: AgentProvider;
  status: RunStatus;
  repoRoot: string;
  workspace: RunWorkspaceRecord;
  artifactUrl?: string | null;
  requestedBy?: string | null;
  promptContractId: string;
  promptDigests: {
    system?: string | null;
    user: string;
  };
  promptProvenance?: PromptProvenanceRecord | null;
  limits: {
    maxWallTimeSec: number;
    idleTimeoutSec: number;
    bootstrapTimeoutSec: number;
  };
  outcome?: RunOutcomeRecord | null;
  createdAt: string;
  admittedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  lastHeartbeatAt?: string | null;
};

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

export type PromptAttachment = {
  kind: PromptAttachmentKind;
  value: string;
  label?: string | null;
};

export type PromptSourceRef = {
  kind: PromptSourceKind;
  ref: string;
};

export type PromptProvenanceSelection = {
  promptPackName: string;
  capabilityNames: string[];
  organizationOverlayNames: string[];
  projectOverlayNames: string[];
  experimentName?: string | null;
};

export type PromptProvenanceSource = {
  kind: PromptSourceKind;
  ref: string;
  digest: string;
};

export type PromptRenderedMetadata = {
  systemPromptLength: number;
  userPromptLength: number;
  attachmentKinds: PromptAttachmentKind[];
  attachmentCount: number;
};

export type PromptProvenanceRecord = {
  selection: PromptProvenanceSelection;
  sources: PromptProvenanceSource[];
  rendered: PromptRenderedMetadata;
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
  promptProvenance?: PromptProvenanceRecord | null;
  limits: {
    maxWallTimeSec: number;
    idleTimeoutSec: number;
    bootstrapTimeoutSec: number;
  };
  requestedBy?: string | null;
};
