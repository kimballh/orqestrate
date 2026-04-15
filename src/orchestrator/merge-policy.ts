import type { MergeMethod, MergePolicyConfig } from "../config/types.js";
import type { GitHubPullRequestMergeReadiness } from "../github/client.js";
import type { PullRequestReviewLoopSnapshot } from "../github/review-loop.js";

export type MergePolicyDisposition =
  | "ready_to_execute"
  | "ready_waiting_human"
  | "reroute_to_review"
  | "reroute_to_implement"
  | "blocked";

export type MergePolicyDecision = {
  disposition: MergePolicyDisposition;
  reasons: string[];
  mergeMethod: MergeMethod | null;
  requiresHumanApproval: boolean;
};

export const DEFAULT_MERGE_POLICY: MergePolicyConfig = {
  allowedMethods: ["squash"],
  requireHumanApproval: false,
};

export function evaluateMergePolicy(input: {
  policy: MergePolicyConfig;
  reviewLoop: PullRequestReviewLoopSnapshot;
  readiness: GitHubPullRequestMergeReadiness;
  humanApproved?: boolean;
}): MergePolicyDecision {
  const reasons: string[] = [];
  const mergeMethod = input.policy.allowedMethods[0] ?? null;
  const requiresHumanApproval = input.policy.requireHumanApproval;

  if (mergeMethod === null) {
    return blocked(
      "No allowed merge method is configured for this repository.",
      requiresHumanApproval,
    );
  }

  if (input.reviewLoop.ambiguousThreadIds.length > 0) {
    return blocked(
      "Unresolved review threads could not be classified safely.",
      requiresHumanApproval,
    );
  }

  if (input.reviewLoop.implementerActionThreadIds.length > 0) {
    return {
      disposition: "reroute_to_implement",
      reasons: [
        "Implementation-side reviewer feedback re-opened after approval.",
      ],
      mergeMethod,
      requiresHumanApproval,
    };
  }

  if (
    input.reviewLoop.reviewerActionThreadIds.length > 0 ||
    input.reviewLoop.hasOpenReviewDecision
  ) {
    return {
      disposition: "reroute_to_review",
      reasons: [
        "Review approval is no longer stable and needs another review pass.",
      ],
      mergeMethod,
      requiresHumanApproval,
    };
  }

  if (input.readiness.pullRequest.state !== "OPEN") {
    reasons.push(
      `Pull request is '${input.readiness.pullRequest.state.toLowerCase()}', not open.`,
    );
  }

  if (input.readiness.pullRequest.isDraft) {
    reasons.push("Pull request is still marked as draft.");
  }

  if (input.readiness.pullRequest.reviewDecision !== "APPROVED") {
    reasons.push("GitHub review decision is not approved.");
  }

  if (input.readiness.pullRequest.mergeable !== "MERGEABLE") {
    const mergeable = input.readiness.pullRequest.mergeable;
    reasons.push(
      mergeable === "UNKNOWN" || mergeable === null
        ? "GitHub mergeability is still unknown."
        : `GitHub mergeability is '${mergeable.toLowerCase()}'.`,
    );
  }

  if (
    input.readiness.pullRequest.mergeStateStatus !== null &&
    input.readiness.pullRequest.mergeStateStatus !== "CLEAN" &&
    input.readiness.pullRequest.mergeStateStatus !== "HAS_HOOKS"
  ) {
    reasons.push(
      `GitHub merge state is '${input.readiness.pullRequest.mergeStateStatus.toLowerCase()}'.`,
    );
  }

  if (input.readiness.statusCheckRollupState !== "SUCCESS") {
    reasons.push(
      input.readiness.statusCheckRollupState === null
        ? "Required status checks are unavailable."
        : `Required status checks are '${input.readiness.statusCheckRollupState.toLowerCase()}'.`,
    );
  }

  const failingChecks = input.readiness.requiredChecks.filter(
    (check) => check.state !== "SUCCESS",
  );
  if (failingChecks.length > 0) {
    reasons.push(
      `Required checks are not green: ${failingChecks.map((check) => check.name).join(", ")}.`,
    );
  }

  if (reasons.length > 0) {
    return {
      disposition: "blocked",
      reasons,
      mergeMethod,
      requiresHumanApproval,
    };
  }

  if (requiresHumanApproval && input.humanApproved !== true) {
    return {
      disposition: "ready_waiting_human",
      reasons: ["Pull request is merge-ready and awaiting explicit human approval."],
      mergeMethod,
      requiresHumanApproval,
    };
  }

  return {
    disposition: "ready_to_execute",
    reasons: ["Pull request passed merge policy and is ready to merge."],
    mergeMethod,
    requiresHumanApproval,
  };
}

function blocked(
  reason: string,
  requiresHumanApproval: boolean,
): MergePolicyDecision {
  return {
    disposition: "blocked",
    reasons: [reason],
    mergeMethod: null,
    requiresHumanApproval,
  };
}
