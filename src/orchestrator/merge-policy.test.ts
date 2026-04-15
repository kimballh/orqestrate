import assert from "node:assert/strict";
import test from "node:test";

import { evaluateMergePolicy } from "./merge-policy.js";

test("evaluateMergePolicy returns ready_to_execute when the PR is merge-ready", () => {
  const decision = evaluateMergePolicy({
    policy: {
      allowedMethods: ["squash"],
      requireHumanApproval: false,
    },
    reviewLoop: createReviewLoopSnapshot(),
    readiness: createMergeReadiness(),
  });

  assert.equal(decision.disposition, "ready_to_execute");
  assert.equal(decision.mergeMethod, "squash");
});

test("evaluateMergePolicy reroutes to implement when reviewer feedback reopens implementation work", () => {
  const decision = evaluateMergePolicy({
    policy: {
      allowedMethods: ["squash"],
      requireHumanApproval: false,
    },
    reviewLoop: createReviewLoopSnapshot({
      implementerActionThreadIds: ["thread-1"],
    }),
    readiness: createMergeReadiness(),
  });

  assert.equal(decision.disposition, "reroute_to_implement");
});

test("evaluateMergePolicy blocks when required checks are not green", () => {
  const decision = evaluateMergePolicy({
    policy: {
      allowedMethods: ["squash"],
      requireHumanApproval: false,
    },
    reviewLoop: createReviewLoopSnapshot(),
    readiness: createMergeReadiness({
      statusCheckRollupState: "PENDING",
      requiredChecks: [
        {
          name: "ci",
          state: "PENDING",
          isRequired: true,
        },
      ],
    }),
  });

  assert.equal(decision.disposition, "blocked");
  assert.match(decision.reasons.join(" "), /required checks/i);
});

test("evaluateMergePolicy waits for explicit human approval when configured", () => {
  const decision = evaluateMergePolicy({
    policy: {
      allowedMethods: ["merge"],
      requireHumanApproval: true,
    },
    reviewLoop: createReviewLoopSnapshot(),
    readiness: createMergeReadiness(),
    humanApproved: false,
  });

  assert.equal(decision.disposition, "ready_waiting_human");
  assert.equal(decision.requiresHumanApproval, true);
});

test("evaluateMergePolicy honors any requested allowed merge method", () => {
  const decision = evaluateMergePolicy({
    policy: {
      allowedMethods: ["squash", "rebase"],
      requireHumanApproval: false,
    },
    reviewLoop: createReviewLoopSnapshot(),
    readiness: createMergeReadiness(),
    requestedMethod: "rebase",
  });

  assert.equal(decision.disposition, "ready_to_execute");
  assert.equal(decision.mergeMethod, "rebase");
});

test("evaluateMergePolicy ignores missing rollup state when no required checks exist", () => {
  const decision = evaluateMergePolicy({
    policy: {
      allowedMethods: ["squash"],
      requireHumanApproval: false,
    },
    reviewLoop: createReviewLoopSnapshot(),
    readiness: createMergeReadiness({
      statusCheckRollupState: null,
      requiredChecks: [],
    }),
  });

  assert.equal(decision.disposition, "ready_to_execute");
  assert.doesNotMatch(decision.reasons.join(" "), /required status checks are unavailable/i);
});

function createReviewLoopSnapshot(
  overrides: Partial<{
    implementerActionThreadIds: string[];
    reviewerActionThreadIds: string[];
    ambiguousThreadIds: string[];
    hasOpenReviewDecision: boolean;
  }> = {},
) {
  return {
    pullRequestUrl: "https://github.com/kimballh/orqestrate/pull/44",
    reviewDecision: "APPROVED",
    unresolvedThreadCount:
      (overrides.implementerActionThreadIds?.length ?? 0) +
      (overrides.reviewerActionThreadIds?.length ?? 0) +
      (overrides.ambiguousThreadIds?.length ?? 0),
    implementerActionThreadIds: overrides.implementerActionThreadIds ?? [],
    reviewerActionThreadIds: overrides.reviewerActionThreadIds ?? [],
    ambiguousThreadIds: overrides.ambiguousThreadIds ?? [],
    hasOpenReviewDecision: overrides.hasOpenReviewDecision ?? false,
    threads: [],
  };
}

function createMergeReadiness(
  overrides: Partial<{
    statusCheckRollupState: string | null;
    requiredChecks: Array<{ name: string; state: string; isRequired: boolean }>;
  }> = {},
) {
  return {
    pullRequest: {
      id: "PR_kwDO44",
      number: 44,
      url: "https://github.com/kimballh/orqestrate/pull/44",
      state: "OPEN",
      isDraft: false,
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
      merged: false,
      mergedAt: null,
      headRefOid: "abc123",
    },
    statusCheckRollupState: overrides.statusCheckRollupState ?? "SUCCESS",
    requiredChecks: overrides.requiredChecks ?? [],
  };
}
