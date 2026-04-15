import assert from "node:assert/strict";
import test from "node:test";

import type { WorkItemRecord } from "../domain-model.js";

import { buildMergeCompletionTransition } from "./merge-completion.js";

test("buildMergeCompletionTransition marks merged pull requests done", async () => {
  const transition = await buildMergeCompletionTransition(
    {
      createGitHubClient: () => ({
        readPullRequest: async () => createPullRequestState(),
        readPullRequestMergeReadiness: async () =>
          createMergeReadiness({
            merged: true,
            mergedAt: "2026-04-15T22:00:00.000Z",
            state: "MERGED",
          }),
      }),
    },
    {
      workItem: createWorkItem(),
      repoRoot: "/repo",
      pullRequestUrl: "https://github.com/kimballh/orqestrate/pull/44",
      runId: "run-44",
    },
  );

  assert.equal(transition.nextStatus, "done");
  assert.equal(transition.nextPhase, "none");
});

test("buildMergeCompletionTransition reroutes back to implement when implementation feedback reopens", async () => {
  const transition = await buildMergeCompletionTransition(
    {
      createGitHubClient: () => ({
        readPullRequest: async () =>
          createPullRequestState({
            threads: [
              {
                id: "thread-1",
                isResolved: false,
                isOutdated: false,
                path: "src/index.ts",
                line: 10,
                originalLine: 10,
                startLine: null,
                originalStartLine: null,
                diffSide: "RIGHT",
                comments: [
                  {
                    id: "comment-1",
                    databaseId: 101,
                    url: "https://github.com/comment/101",
                    body: "Please address this before merge.",
                    authorLogin: "reviewer",
                    createdAt: "2026-04-15T22:00:00.000Z",
                  },
                ],
              },
            ],
          }),
        readPullRequestMergeReadiness: async () => createMergeReadiness(),
      }),
    },
    {
      workItem: createWorkItem(),
      repoRoot: "/repo",
      pullRequestUrl: "https://github.com/kimballh/orqestrate/pull/44",
      runId: "run-44",
    },
  );

  assert.equal(transition.nextStatus, "implement");
  assert.equal(transition.nextPhase, "implement");
});

function createWorkItem(): WorkItemRecord {
  return {
    id: "ORQ-44",
    identifier: "ORQ-44",
    title: "Implement merge policy evaluation and merge execution path",
    description: null,
    status: "review",
    phase: "merge",
    priority: 2,
    labels: [],
    url: "https://linear.app/orqestrate/issue/ORQ-44",
    parentId: null,
    dependencyIds: [],
    blockedByIds: [],
    blocksIds: [],
    artifactUrl: null,
    updatedAt: "2026-04-15T00:00:00.000Z",
    createdAt: "2026-04-15T00:00:00.000Z",
    orchestration: {
      state: "queued",
      owner: null,
      runId: null,
      leaseUntil: null,
      reviewOutcome: "approved",
      blockedReason: null,
      lastError: null,
      attemptCount: 0,
    },
  };
}

function createPullRequestState(
  overrides: Partial<{
    threads: Array<{
      id: string;
      isResolved: boolean;
      isOutdated: boolean;
      path: string | null;
      line: number | null;
      originalLine: number | null;
      startLine: number | null;
      originalStartLine: number | null;
      diffSide: string | null;
      comments: Array<{
        id: string;
        databaseId: number | null;
        url: string;
        body: string;
        authorLogin: string | null;
        createdAt: string | null;
      }>;
    }>;
  }> = {},
) {
  return {
    viewerLogin: "reviewer",
    pullRequest: {
      id: "PR_kwDO44",
      number: 44,
      title: "Implement ORQ-44",
      url: "https://github.com/kimballh/orqestrate/pull/44",
      state: "OPEN",
      isDraft: false,
      body: "Body",
      baseRefName: "main",
      headRefName: "hillkimball/orq-44",
      reviewDecision: "APPROVED",
      authorLogin: "kimballh",
    },
    files: [],
    reviews: [],
    threads: overrides.threads ?? [],
  };
}

function createMergeReadiness(
  overrides: Partial<{
    merged: boolean;
    mergedAt: string | null;
    state: string;
  }> = {},
) {
  return {
    pullRequest: {
      id: "PR_kwDO44",
      number: 44,
      url: "https://github.com/kimballh/orqestrate/pull/44",
      state: overrides.state ?? "OPEN",
      isDraft: false,
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
      merged: overrides.merged ?? false,
      mergedAt: overrides.mergedAt ?? null,
      headRefOid: "abc123",
    },
    statusCheckRollupState: "SUCCESS",
    requiredChecks: [],
  };
}
