import type { MergePolicyConfig } from "../config/types.js";
import type { TransitionWorkItemInput } from "../core/planning-backend.js";
import type { GitHubCliClient } from "../github/client.js";
import { GitHubCliClient as DefaultGitHubCliClient } from "../github/client.js";
import {
  classifyPullRequestReviewLoop,
} from "../github/review-loop.js";
import { parsePullRequestUrl } from "../github/scope.js";
import type { WorkItemRecord } from "../domain-model.js";

import {
  DEFAULT_MERGE_POLICY,
  evaluateMergePolicy,
} from "./merge-policy.js";
import { buildBlockedTransition } from "./transition-policy.js";

export type MergeCompletionDependencies = {
  mergePolicy?: MergePolicyConfig;
  createGitHubClient?: (
    cwd: string,
  ) => Pick<GitHubCliClient, "readPullRequest" | "readPullRequestMergeReadiness">;
};

export async function buildMergeCompletionTransition(
  dependencies: MergeCompletionDependencies,
  input: {
    workItem: WorkItemRecord;
    repoRoot: string;
    pullRequestUrl: string | null | undefined;
    runId: string;
  },
): Promise<TransitionWorkItemInput> {
  const pullRequestUrl = input.pullRequestUrl?.trim();
  if (pullRequestUrl === undefined || pullRequestUrl.length === 0) {
    return buildBlockedTransition({
      workItem: input.workItem,
      runId: input.runId,
      blockedReason:
        "Merge run completed, but the linked pull request context was missing.",
    });
  }

  const client =
    dependencies.createGitHubClient?.(input.repoRoot) ??
    new DefaultGitHubCliClient({
      cwd: input.repoRoot,
    });
  const pullRequest = parsePullRequestUrl(pullRequestUrl);
  const [pullRequestState, mergeReadiness] = await Promise.all([
    client.readPullRequest(pullRequest),
    client.readPullRequestMergeReadiness(pullRequest),
  ]);

  if (
    mergeReadiness.pullRequest.merged ||
    mergeReadiness.pullRequest.mergedAt !== null ||
    mergeReadiness.pullRequest.state === "MERGED"
  ) {
    return {
      id: input.workItem.id,
      nextStatus: "done",
      nextPhase: "none",
      state: "completed",
      runId: input.runId,
      reviewOutcome: "approved",
      blockedReason: null,
      lastError: null,
    };
  }

  const decision = evaluateMergePolicy({
    policy: dependencies.mergePolicy ?? DEFAULT_MERGE_POLICY,
    reviewLoop: classifyPullRequestReviewLoop(pullRequestState),
    readiness: mergeReadiness,
  });

  switch (decision.disposition) {
    case "reroute_to_implement":
      return {
        id: input.workItem.id,
        nextStatus: "implement",
        nextPhase: "implement",
        state: "queued",
        runId: input.runId,
        reviewOutcome: "changes_requested",
        blockedReason: null,
        lastError: null,
      };
    case "reroute_to_review":
      return {
        id: input.workItem.id,
        nextStatus: "review",
        nextPhase: "review",
        state: "queued",
        runId: input.runId,
        reviewOutcome: "none",
        blockedReason: null,
        lastError: null,
      };
    case "ready_waiting_human":
      return buildBlockedTransition({
        workItem: input.workItem,
        runId: input.runId,
        blockedReason: decision.reasons.join(" "),
      });
    case "ready_to_execute":
      return buildBlockedTransition({
        workItem: input.workItem,
        runId: input.runId,
        blockedReason:
          "Merge run completed, but the linked pull request remained merge-ready and unmerged.",
      });
    case "blocked":
      return buildBlockedTransition({
        workItem: input.workItem,
        runId: input.runId,
        blockedReason: decision.reasons.join(" "),
      });
  }
}
