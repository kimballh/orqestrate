import type {
  AgentProvider,
  ProviderError,
  RunRecord,
  RunStatus,
  RunSubmissionPayload,
  VerificationSummary,
  WorkPhase,
  WorkspaceMode,
} from "../domain-model.js";

export const WORKSPACE_ALLOCATION_STATUSES = [
  "preparing",
  "ready",
  "in_use",
  "releasing",
  "released",
  "dirty",
  "cleanup_failed",
] as const;

export type WorkspaceAllocationStatus =
  (typeof WORKSPACE_ALLOCATION_STATUSES)[number];

export const RUN_EVENT_LEVELS = ["debug", "info", "warn", "error"] as const;

export type RunEventLevel = (typeof RUN_EVENT_LEVELS)[number];

export const RUN_EVENT_SOURCES = [
  "api",
  "scheduler",
  "workspace",
  "supervisor",
  "provider",
] as const;

export type RunEventSource = (typeof RUN_EVENT_SOURCES)[number];

export const HEARTBEAT_SOURCES = [
  "pty_output",
  "pty_input",
  "workspace",
  "adapter_probe",
  "supervisor_tick",
] as const;

export type HeartbeatSource = (typeof HEARTBEAT_SOURCES)[number];

export type PersistedRunRecord = RunRecord & {
  priority: number;
  runtimeOwner?: string | null;
  attemptCount: number;
  waitingHumanReason?: string | null;
  readyAt?: string | null;
  version: number;
};

export type CreateRunInput = RunSubmissionPayload & {
  priority?: number;
};

export type ListRunsFilters = {
  status?: RunStatus;
  provider?: AgentProvider;
  workItemId?: string;
  phase?: WorkPhase;
  repoRoot?: string;
  limit?: number;
};

export type RunEventRecord = {
  seq: number;
  runId: string;
  eventType: string;
  level: RunEventLevel;
  source: RunEventSource;
  occurredAt: string;
  payload: Record<string, unknown>;
};

export type AppendRunEventInput = Omit<RunEventRecord, "seq">;

export type ListRunEventsOptions = {
  afterSeq?: number;
  limit?: number;
};

export type SessionHeartbeatRecord = {
  heartbeatId: number;
  runId: string;
  emittedAt: string;
  source: HeartbeatSource;
  bytesRead: number;
  bytesWritten: number;
  fileChanges: number;
  providerState?: string | null;
  note?: string | null;
};

export type RecordHeartbeatInput = Omit<SessionHeartbeatRecord, "heartbeatId">;

export type WorkspaceAllocationRecord = {
  workspaceAllocationId: string;
  repoKey: string;
  repoRoot: string;
  mode: WorkspaceMode;
  workingDir: string;
  branchName?: string | null;
  baseRef?: string | null;
  status: WorkspaceAllocationStatus;
  claimedByRunId?: string | null;
  createdAt: string;
  readyAt?: string | null;
  claimedAt?: string | null;
  releasedAt?: string | null;
  leaseUntil?: string | null;
  cleanupError?: string | null;
};

export type CreateWorkspaceAllocationInput = {
  workspaceAllocationId: string;
  repoKey: string;
  repoRoot: string;
  mode: WorkspaceMode;
  workingDir: string;
  branchName?: string | null;
  baseRef?: string | null;
  status?: WorkspaceAllocationStatus;
  claimedByRunId?: string | null;
  createdAt?: string;
  readyAt?: string | null;
  claimedAt?: string | null;
  releasedAt?: string | null;
  leaseUntil?: string | null;
  cleanupError?: string | null;
};

export type UpdateWorkspaceAllocationStatusInput = {
  workspaceAllocationId: string;
  status: WorkspaceAllocationStatus;
  branchName?: string | null;
  baseRef?: string | null;
  claimedByRunId?: string | null;
  readyAt?: string | null;
  claimedAt?: string | null;
  releasedAt?: string | null;
  leaseUntil?: string | null;
  cleanupError?: string | null;
};

export type RuntimeOutcomeSnapshot = {
  summary?: string | null;
  verification?: VerificationSummary | null;
  error?: ProviderError | null;
};
