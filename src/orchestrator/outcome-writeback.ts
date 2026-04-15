import type { MergePolicyConfig } from "../config/types.js";
import type { ArtifactRecord, ProviderError, ReviewOutcome, RunLedgerRecord, RunRecord, VerificationSummary, WorkItemRecord } from "../domain-model.js";
import type { ContextBackend } from "../core/context-backend.js";
import type { PlanningBackend, TransitionWorkItemInput } from "../core/planning-backend.js";
import type { GitHubCliClient } from "../github/client.js";
import {
  classifyPullRequestReviewLoop,
  computePullRequestReviewLoopFingerprint,
} from "../github/review-loop.js";
import { parsePullRequestUrl } from "../github/scope.js";
import { GitHubCliClient as DefaultGitHubCliClient } from "../github/client.js";

import { buildMergeCompletionTransition } from "./merge-completion.js";
import { buildBlockedTransition, buildRetryableFailureTransition } from "./transition-policy.js";
import type { PreparedOrchestrationRun, WatchedRunOutcome } from "./types.js";

export type ApplyRunOutcomeDependencies = {
  planning: PlanningBackend;
  context: ContextBackend;
  mergePolicy?: MergePolicyConfig;
  createGitHubClient?: (
    cwd: string,
  ) => Pick<GitHubCliClient, "readPullRequest" | "readPullRequestMergeReadiness">;
};

export type ApplyRunOutcomeResult = {
  artifact: ArtifactRecord | null;
  workItem: WorkItemRecord;
  runLedger: RunLedgerRecord;
  commentBody: string | null;
};

export async function applyRunOutcome(
  dependencies: ApplyRunOutcomeDependencies,
  prepared: PreparedOrchestrationRun,
  watched: WatchedRunOutcome,
): Promise<ApplyRunOutcomeResult> {
  switch (watched.run.status) {
    case "completed":
      return applyCompletedOutcome(dependencies, prepared, watched);
    case "waiting_human":
      return applyWaitingHumanOutcome(dependencies, prepared, watched);
    case "failed":
    case "canceled":
    case "stale":
      return applyNonSuccessOutcome(dependencies, prepared, watched);
    default:
      throw new Error(
        `Run '${prepared.runId}' ended orchestration with unsupported status '${watched.run.status}'.`,
      );
  }
}

async function applyCompletedOutcome(
  dependencies: ApplyRunOutcomeDependencies,
  prepared: PreparedOrchestrationRun,
  watched: WatchedRunOutcome,
): Promise<ApplyRunOutcomeResult> {
  const outcome = watched.run.outcome ?? {};
  const artifact = await writeArtifactIfNeeded(dependencies.context, prepared, outcome, watched.run);
  const verification = outcome.verification ?? null;
  const evidenceContent = renderEvidenceContent({
    run: watched.run,
    waitingHumanReason: watched.waitingHumanReason ?? null,
    waitingHumanDetails: watched.waitingHumanDetails ?? null,
  });

  if (evidenceContent !== null) {
    await dependencies.context.appendEvidence({
      runId: prepared.runId,
      workItemId: prepared.claimedWorkItem.id,
      section: "Run Outcome",
      content: evidenceContent,
    });
  }

  const runLedger = await dependencies.context.finalizeRunLedgerEntry({
    runId: prepared.runId,
    status: "completed",
    summary: outcome.summary ?? defaultSummaryForStatus("completed", prepared.phase),
    verification,
    error: outcome.error ?? null,
  });

  const transition = await buildCompletedTransition(
    dependencies,
    prepared,
    outcome.reviewOutcome ?? null,
  );
  const workItem = await dependencies.planning.transitionWorkItem(transition);
  const commentBody = buildCompletionComment({
    prepared,
    artifact,
    workItem,
    summary: outcome.summary ?? null,
    verification,
    reviewOutcome: outcome.reviewOutcome ?? null,
  });

  if (commentBody !== null) {
    await dependencies.planning.appendComment({
      id: prepared.claimedWorkItem.id,
      body: commentBody,
    });
  }

  return {
    artifact,
    workItem,
    runLedger,
    commentBody,
  };
}

async function applyWaitingHumanOutcome(
  dependencies: ApplyRunOutcomeDependencies,
  prepared: PreparedOrchestrationRun,
  watched: WatchedRunOutcome,
): Promise<ApplyRunOutcomeResult> {
  const outcome = watched.run.outcome ?? {};
  const evidenceContent = renderEvidenceContent({
    run: watched.run,
    waitingHumanReason: watched.waitingHumanReason ?? null,
    waitingHumanDetails: watched.waitingHumanDetails ?? null,
  });

  if (evidenceContent !== null) {
    await dependencies.context.appendEvidence({
      runId: prepared.runId,
      workItemId: prepared.claimedWorkItem.id,
      section: "Waiting Human",
      content: evidenceContent,
    });
  }

  const summary =
    watched.waitingHumanReason ??
    outcome.requestedHumanInput ??
    watched.run.waitingHumanReason ??
    outcome.summary ??
    "Run is waiting for human input.";
  const runLedger = await dependencies.context.finalizeRunLedgerEntry({
    runId: prepared.runId,
    status: "waiting_human",
    summary,
    verification: outcome.verification ?? null,
    error: outcome.error ?? null,
  });
  const workItem = await dependencies.planning.transitionWorkItem(
    buildBlockedTransition({
      workItem: prepared.claimedWorkItem,
      runId: prepared.runId,
      blockedReason: summary,
      error: outcome.error ?? null,
    }),
  );
  const commentBody = buildWaitingHumanComment(prepared, summary, artifactUrl(prepared.artifact));
  await dependencies.planning.appendComment({
    id: prepared.claimedWorkItem.id,
    body: commentBody,
  });

  return {
    artifact: prepared.artifact,
    workItem,
    runLedger,
    commentBody,
  };
}

async function applyNonSuccessOutcome(
  dependencies: ApplyRunOutcomeDependencies,
  prepared: PreparedOrchestrationRun,
  watched: WatchedRunOutcome,
): Promise<ApplyRunOutcomeResult> {
  const outcome = watched.run.outcome ?? {};
  const summary =
    outcome.summary ?? defaultSummaryForStatus(watched.run.status, prepared.phase);
  const runtimeError =
    outcome.error ??
    buildOutcomeError(prepared, watched.run.status, summary);
  const evidenceContent = renderEvidenceContent({
    run: watched.run,
    waitingHumanReason: watched.waitingHumanReason ?? null,
    waitingHumanDetails: watched.waitingHumanDetails ?? null,
  });

  if (evidenceContent !== null) {
    await dependencies.context.appendEvidence({
      runId: prepared.runId,
      workItemId: prepared.claimedWorkItem.id,
      section: "Failure",
      content: evidenceContent,
    });
  }

  const runLedger = await dependencies.context.finalizeRunLedgerEntry({
    runId: prepared.runId,
    status: watched.run.status,
    summary,
    verification: outcome.verification ?? null,
    error: runtimeError,
  });
  const workItem = await dependencies.planning.transitionWorkItem(
    buildRetryableFailureTransition({
      workItem: prepared.claimedWorkItem,
      runId: prepared.runId,
      error: runtimeError,
    }),
  );
  const commentBody = buildFailureComment(prepared, watched.run, summary);
  await dependencies.planning.appendComment({
    id: prepared.claimedWorkItem.id,
    body: commentBody,
  });

  return {
    artifact: prepared.artifact,
    workItem,
    runLedger,
    commentBody,
  };
}

async function writeArtifactIfNeeded(
  context: ContextBackend,
  prepared: PreparedOrchestrationRun,
  outcome: RunRecord["outcome"],
  run: RunRecord,
): Promise<ArtifactRecord | null> {
  if (prepared.phase === "review" && outcome?.reviewOutcome === null) {
    // Preserve the review notes, but do not advance workflow until review disposition is explicit.
  }

  const content = buildArtifactContent(prepared.phase, outcome, run);
  if (content === null) {
    return prepared.artifact;
  }

  const ensuredArtifact =
    prepared.artifact ??
    (await context.ensureArtifact({ workItem: prepared.claimedWorkItem }));

  return context.writePhaseArtifact({
    workItem: prepared.claimedWorkItem,
    artifact: ensuredArtifact,
    phase: prepared.phase,
    content,
    summary: outcome?.summary ?? null,
  });
}

async function buildCompletedTransition(
  dependencies: ApplyRunOutcomeDependencies,
  prepared: PreparedOrchestrationRun,
  reviewOutcome: Exclude<ReviewOutcome, "none"> | null,
): Promise<TransitionWorkItemInput> {
  switch (prepared.phase) {
    case "design":
      return {
        id: prepared.claimedWorkItem.id,
        nextStatus: "plan",
        nextPhase: "plan",
        state: "queued",
        runId: prepared.runId,
      };
    case "plan":
      return {
        id: prepared.claimedWorkItem.id,
        nextStatus: "implement",
        nextPhase: "implement",
        state: "queued",
        runId: prepared.runId,
      };
    case "implement":
      if (
        prepared.reviewLoop !== null &&
        prepared.reviewLoop.implementerActionThreadIds.length > 0
      ) {
        const client =
          dependencies.createGitHubClient?.(
            prepared.submission.workspace.repoRoot,
          ) ??
          new DefaultGitHubCliClient({
            cwd: prepared.submission.workspace.repoRoot,
          });
        const pullRequest = parsePullRequestUrl(
          prepared.reviewLoop.pullRequestUrl,
        );
        const refreshedSnapshot = classifyPullRequestReviewLoop(
          await client.readPullRequest(pullRequest),
        );
        const beforeFingerprint = computePullRequestReviewLoopFingerprint(
          prepared.reviewLoop.implementerActionThreadIds,
        );
        const afterFingerprint = computePullRequestReviewLoopFingerprint(
          refreshedSnapshot.implementerActionThreadIds,
        );

        if (refreshedSnapshot.ambiguousThreadIds.length > 0) {
          return buildBlockedTransition({
            workItem: prepared.claimedWorkItem,
            runId: prepared.runId,
            blockedReason:
              "Implement run completed, but the linked pull request still has ambiguous unresolved review threads.",
          });
        }

        if (beforeFingerprint.length > 0 && beforeFingerprint === afterFingerprint) {
          return buildBlockedTransition({
            workItem: prepared.claimedWorkItem,
            runId: prepared.runId,
            blockedReason:
              "Implement run completed, but the linked pull request still shows the same unresolved reviewer feedback and needs human triage.",
          });
        }
      }

      return {
        id: prepared.claimedWorkItem.id,
        nextStatus: "review",
        nextPhase: "review",
        state: "queued",
        runId: prepared.runId,
      };
    case "review":
      if (reviewOutcome === "changes_requested") {
        return {
          id: prepared.claimedWorkItem.id,
          nextStatus: "implement",
          nextPhase: "implement",
          state: "queued",
          runId: prepared.runId,
          reviewOutcome,
        };
      }

      if (reviewOutcome === "approved") {
        return {
          id: prepared.claimedWorkItem.id,
          nextStatus: "review",
          nextPhase: "merge",
          state: "queued",
          runId: prepared.runId,
          reviewOutcome,
        };
      }

      return {
        id: prepared.claimedWorkItem.id,
        nextStatus: "blocked",
        nextPhase: "review",
        state: "waiting_human",
        runId: prepared.runId,
        blockedReason: "Review completed without an explicit review outcome.",
      };
    case "merge":
      return buildMergeCompletionTransition(
        {
          mergePolicy: dependencies.mergePolicy,
          createGitHubClient: dependencies.createGitHubClient,
        },
        {
          workItem: prepared.claimedWorkItem,
          repoRoot: prepared.submission.workspace.repoRoot,
          pullRequestUrl: prepared.submission.workspace.pullRequestUrl,
          runId: prepared.runId,
        },
      );
  }
}

function buildArtifactContent(
  phase: PreparedOrchestrationRun["phase"],
  outcome: RunRecord["outcome"],
  run: RunRecord,
): string | null {
  if (outcome?.artifactMarkdown?.trim()) {
    return outcome.artifactMarkdown.trim();
  }

  const parts = [outcome?.summary, outcome?.details]
    .filter((value): value is string => value !== undefined && value !== null && value.trim() !== "")
    .map((value) => value.trim());

  if (parts.length > 0) {
    return parts.join("\n\n");
  }

  if (phase === "review" || phase === "merge") {
    return `# ${capitalizePhase(phase)}\n\nRun ${run.runId} completed without structured artifact content.`;
  }

  return null;
}

function renderEvidenceContent(input: {
  run: RunRecord;
  waitingHumanReason: string | null;
  waitingHumanDetails: string | null;
}): string | null {
  const outcome = input.run.outcome;
  const lines = [
    `Run ID: ${input.run.runId}`,
    `Status: ${input.run.status}`,
    outcome?.summary ? `Summary: ${outcome.summary}` : null,
    outcome?.details ? `Details:\n${outcome.details}` : null,
    outcome?.requestedHumanInput
      ? `Requested Human Input:\n${outcome.requestedHumanInput}`
      : null,
    input.waitingHumanReason ? `Waiting Human Reason: ${input.waitingHumanReason}` : null,
    input.waitingHumanDetails ? `Waiting Human Details:\n${input.waitingHumanDetails}` : null,
    renderVerificationBlock(outcome?.verification ?? null),
  ].filter((value): value is string => value !== null);

  if (lines.length === 2 && outcome?.summary == null && outcome?.details == null) {
    return null;
  }

  return lines.join("\n\n");
}

function renderVerificationBlock(
  verification: VerificationSummary | null,
): string | null {
  if (verification === null) {
    return null;
  }

  return [
    "Verification:",
    verification.commands.length > 0
      ? verification.commands.map((command) => `- ${command}`).join("\n")
      : "- no commands reported",
    `- passed: ${verification.passed}`,
    verification.notes ? `- notes: ${verification.notes}` : null,
  ]
    .filter((value): value is string => value !== null)
    .join("\n");
}

function buildCompletionComment(input: {
  prepared: PreparedOrchestrationRun;
  artifact: ArtifactRecord | null;
  workItem: WorkItemRecord;
  summary: string | null;
  verification: VerificationSummary | null;
  reviewOutcome: Exclude<ReviewOutcome, "none"> | null;
}): string | null {
  const artifactLink = artifactLinkMarkdown(input.artifact);
  const summary = input.summary ?? defaultSummaryForStatus("completed", input.prepared.phase);

  if (input.prepared.phase === "review" && input.reviewOutcome === null) {
    return [
      `Review artifact updated${artifactLink === null ? "." : `: ${artifactLink}`}`,
      "",
      "The review run completed, but it did not return an explicit `approved` or `changes_requested` outcome.",
      "The ticket was left in `Blocked` so a human can decide how to route it.",
    ].join("\n");
  }

  const lines = [
    `${capitalizePhase(input.prepared.phase)} run completed${artifactLink === null ? "." : `: ${artifactLink}`}`,
    "",
    summary,
  ];

  if (
    input.workItem.status === "blocked" &&
    input.workItem.orchestration.blockedReason !== null
  ) {
    lines.push("", `Blocked reason: ${input.workItem.orchestration.blockedReason}`);
  }

  if (input.verification !== null) {
    lines.push("", renderVerificationBlock(input.verification) ?? "");
  }

  return lines.join("\n").trim();
}

function buildWaitingHumanComment(
  prepared: PreparedOrchestrationRun,
  summary: string,
  artifactUrlValue: string | null,
): string {
  const artifactLink =
    artifactUrlValue === null ? null : `[artifact](${artifactUrlValue})`;
  return [
    `${capitalizePhase(prepared.phase)} run is waiting for human input.`,
    "",
    summary,
    artifactLink === null ? null : `Artifact: ${artifactLink}`,
  ]
    .filter((value): value is string => value !== null)
    .join("\n");
}

function buildFailureComment(
  prepared: PreparedOrchestrationRun,
  run: RunRecord,
  summary: string,
): string {
  return [
    `${capitalizePhase(prepared.phase)} run ended with \`${run.status}\`.`,
    "",
    summary,
  ].join("\n");
}

function buildOutcomeError(
  prepared: PreparedOrchestrationRun,
  status: RunRecord["status"],
  summary: string,
): ProviderError {
  return {
    providerFamily: "runtime",
    providerKind: prepared.submission.provider,
    code: status === "canceled" ? "transport" : "unknown",
    message: summary,
    retryable: status !== "canceled",
    details: {
      runStatus: status,
    },
  };
}

function defaultSummaryForStatus(
  status: RunRecord["status"],
  phase: PreparedOrchestrationRun["phase"],
): string {
  switch (status) {
    case "completed":
      return `${capitalizePhase(phase)} run completed successfully.`;
    case "failed":
      return `${capitalizePhase(phase)} run failed before it could finish cleanly.`;
    case "canceled":
      return `${capitalizePhase(phase)} run was canceled.`;
    case "stale":
      return `${capitalizePhase(phase)} run became stale and needs reconciliation.`;
    default:
      return `${capitalizePhase(phase)} run ended with status ${status}.`;
  }
}

function capitalizePhase(phase: PreparedOrchestrationRun["phase"]): string {
  return phase.slice(0, 1).toUpperCase() + phase.slice(1);
}

function artifactLinkMarkdown(artifact: ArtifactRecord | null): string | null {
  const url = artifactUrl(artifact);
  return url === null ? null : `[${artifact?.title ?? "artifact"}](${url})`;
}

function artifactUrl(artifact: ArtifactRecord | null): string | null {
  return artifact?.url ?? null;
}
