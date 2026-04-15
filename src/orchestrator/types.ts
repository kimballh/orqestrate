import type {
  AgentProvider,
  PromptAttachment,
  ProviderError,
  RunLedgerRecord,
  RunSubmissionPayload,
  WorkItemRecord,
  WorkPhase,
  WorkPhaseOrNone,
  WorkspaceMode,
} from "../domain-model.js";
import type {
  ContextBundle,
  ContextReference,
} from "../core/context-backend.js";
import type {
  PromptAssemblyAddition,
  PromptAssemblyContext,
} from "../core/prompt-assembly.js";
import type { PullRequestReviewLoopSnapshot } from "../github/review-loop.js";
import type { RuntimeApiRun } from "../runtime/api/types.js";

export const EXECUTABLE_WORK_PHASES = [
  "design",
  "plan",
  "implement",
  "review",
] as const;

export type ExecutableWorkPhase = (typeof EXECUTABLE_WORK_PHASES)[number];

export type PhaseResolutionReason =
  | "status_not_actionable"
  | "blocked_status"
  | "phase_missing"
  | "phase_mismatch"
  | "reserved_phase";

export type ClaimBlockReason =
  | "phase_not_actionable"
  | "lease_active"
  | "lease_missing"
  | "has_open_blockers"
  | "waiting_human";

export type PhaseResolution =
  | {
      actionable: true;
      phase: ExecutableWorkPhase;
    }
  | {
      actionable: false;
      reason: PhaseResolutionReason;
      message: string;
      phase: WorkPhaseOrNone;
      expectedPhase?: ExecutableWorkPhase;
    };

export type ClaimDecision =
  | {
      claimable: true;
      phase: ExecutableWorkPhase;
      hasExpiredLease: boolean;
    }
  | {
      claimable: false;
      phase?: ExecutableWorkPhase;
      reason: ClaimBlockReason;
      message: string;
    };

export type PreparedRunWorkspace = RunSubmissionPayload["workspace"] & {
  workingDirHint: string;
};

export type PreparedOrchestrationRun = {
  runId: string;
  owner: string;
  leaseUntil: string;
  leaseDurationMs: number;
  phase: ExecutableWorkPhase;
  claimedWorkItem: WorkItemRecord;
  artifact: ContextBundle["artifact"];
  reviewLoop: PullRequestReviewLoopSnapshot | null;
  context: ContextBundle;
  runLedger: RunLedgerRecord;
  submission: RunSubmissionPayload;
};

export type WatchedRunOutcome = {
  run: RuntimeApiRun;
  lastEventSeq: number | null;
  waitingHumanReason?: string | null;
  waitingHumanDetails?: string | null;
};

export type PrepareClaimedRunResult =
  | {
      ok: true;
      prepared: PreparedOrchestrationRun;
      resolution: Extract<PhaseResolution, { actionable: true }>;
      decision: Extract<ClaimDecision, { claimable: true }>;
    }
  | {
      ok: false;
      workItem: WorkItemRecord;
      resolution: PhaseResolution;
      decision?: ClaimDecision;
    };

export type PrepareClaimedRunWorkspaceInput = {
  mode?: WorkspaceMode;
  baseRef?: string | null;
  assignedBranch?: string | null;
  pullRequestUrl?: string | null;
  pullRequestMode?: string | null;
  writeScope?: string | null;
  workingDirHint?: string | null;
};

export type PrepareClaimedRunPromptInput = {
  promptPackName?: string;
  capabilities?: string[];
  experiment?: string | null;
  runAdditions?: PromptAssemblyAddition[];
  expectations?: PromptAssemblyContext["expectations"];
  operatorNote?: string | null;
  additionalContext?: string | null;
  attachments?: PromptAttachment[];
};

export type PrepareClaimedRunInput = {
  workItemId: string;
  provider: AgentProvider;
  repoRoot: string;
  owner: string;
  requestedBy?: string | null;
  workspace?: PrepareClaimedRunWorkspaceInput;
  prompt?: PrepareClaimedRunPromptInput;
  leaseDurationMs?: number;
  now?: Date;
  createRunId?: () => string;
};

export type PreflightFailureDisposition =
  | {
      kind: "retryable";
      error: ProviderError;
    }
  | {
      kind: "blocked";
      blockedReason: string;
      error?: ProviderError | null;
    };

export type PostClaimFailureContext = {
  claimedWorkItem: WorkItemRecord;
  phase: ExecutableWorkPhase;
  runId: string;
  step:
    | "ensure_artifact"
    | "load_context"
    | "create_run_ledger"
    | "assemble_prompt"
    | "build_submission";
};

export type ClassifyPostClaimFailure = (
  error: unknown,
  context: PostClaimFailureContext,
) => PreflightFailureDisposition;

export type PreflightArtifactReference = Pick<
  NonNullable<PreparedOrchestrationRun["artifact"]>,
  "artifactId" | "url" | "summary"
>;

export type PromptContextReference = ContextReference;
