import assert from "node:assert/strict";
import test from "node:test";

import {
  appendPullRequestReviewLoopMarker,
  classifyPullRequestReviewLoop,
  computePullRequestReviewLoopFingerprint,
  parsePullRequestReviewLoopMarker,
  renderPullRequestReviewLoopContext,
  stripPullRequestReviewLoopMarkers,
} from "./review-loop.js";

test("appends, parses, and strips review-loop markers", () => {
  const body = appendPullRequestReviewLoopMarker("Addressed in 4f2a9d1.", {
    runId: "run-43",
    phase: "implement",
    role: "implement",
    threadId: "thread-1",
  });

  assert.match(body, /orqestrate:review-loop/);
  assert.deepEqual(parsePullRequestReviewLoopMarker(body), {
    runId: "run-43",
    phase: "implement",
    role: "implement",
    threadId: "thread-1",
  });
  assert.equal(stripPullRequestReviewLoopMarkers(body), "Addressed in 4f2a9d1.");
});

test("classifies reviewer feedback as implementer action and marked implementer replies as reviewer action", () => {
  const implementReply = appendPullRequestReviewLoopMarker(
    "Updated the orchestration handoff and added tests.",
    {
      runId: "run-44",
      phase: "implement",
      role: "implement",
      threadId: "thread-2",
    },
  );

  const snapshot = classifyPullRequestReviewLoop(
    createPullRequestReadResult([
      {
        id: "thread-1",
        comments: [
          {
            body: "Please requeue implement when unresolved threads still point at code changes.",
            authorLogin: "reviewer-a",
          },
        ],
      },
      {
        id: "thread-2",
        comments: [
          {
            body: "Need a bounded re-review path here too.",
            authorLogin: "reviewer-b",
          },
          {
            body: implementReply,
            authorLogin: "kimballh",
          },
        ],
      },
    ]),
  );

  assert.deepEqual(snapshot.implementerActionThreadIds, ["thread-1"]);
  assert.deepEqual(snapshot.reviewerActionThreadIds, ["thread-2"]);
  assert.deepEqual(snapshot.ambiguousThreadIds, []);
  assert.equal(
    computePullRequestReviewLoopFingerprint(snapshot.implementerActionThreadIds),
    "thread-1",
  );
});

test("treats same-actor unmarked replies as ambiguous so the loop fails closed", () => {
  const snapshot = classifyPullRequestReviewLoop(
    createPullRequestReadResult([
      {
        id: "thread-3",
        comments: [
          {
            body: "Please address the missing unchanged-thread guardrail.",
            authorLogin: "reviewer-a",
          },
          {
            body: "I think this is already handled in write-back.",
            authorLogin: "kimballh",
          },
        ],
      },
    ]),
  );

  assert.deepEqual(snapshot.implementerActionThreadIds, []);
  assert.deepEqual(snapshot.reviewerActionThreadIds, []);
  assert.deepEqual(snapshot.ambiguousThreadIds, ["thread-3"]);
});

test("renders compact review-loop context for implement runs", () => {
  const snapshot = classifyPullRequestReviewLoop(
    createPullRequestReadResult([
      {
        id: "thread-4",
        path: "src/orchestrator/outcome-writeback.ts",
        line: 52,
        comments: [
          {
            body: "Guard the review bounce when the same unresolved thread set remains.",
            authorLogin: "reviewer-a",
          },
        ],
      },
    ]),
  );

  const rendered = renderPullRequestReviewLoopContext({
    phase: "implement",
    snapshot,
  });

  assert.match(rendered ?? "", /Threads requiring implementation action: 1/);
  assert.match(
    rendered ?? "",
    /src\/orchestrator\/outcome-writeback\.ts:52 - Guard the review bounce/,
  );
});

function createPullRequestReadResult(
  threads: Array<{
    id: string;
    path?: string | null;
    line?: number | null;
    comments: Array<{
      body: string;
      authorLogin: string | null;
    }>;
  }>,
) {
  return {
    viewerLogin: "kimballh",
    pullRequest: {
      id: "PR_kwDOORQ43",
      number: 43,
      title: "Implement ORQ-43",
      url: "https://github.com/kimballh/orqestrate/pull/43",
      state: "OPEN",
      isDraft: false,
      body: "Implements the GitHub review loop.",
      baseRefName: "main",
      headRefName: "hillkimball/orq-43",
      reviewDecision: "REVIEW_REQUIRED",
      authorLogin: "kimballh",
    },
    files: [],
    reviews: [],
    threads: threads.map((thread) => ({
      id: thread.id,
      isResolved: false,
      isOutdated: false,
      path: thread.path ?? "src/index.ts",
      line: thread.line ?? 10,
      originalLine: thread.line ?? 10,
      startLine: null,
      originalStartLine: null,
      diffSide: "RIGHT",
      comments: thread.comments.map((comment, index) => ({
        id: `${thread.id}-comment-${index + 1}`,
        databaseId: 100 + index,
        url: `https://github.com/kimballh/orqestrate/pull/43#discussion_r${index + 1}`,
        body: comment.body,
        authorLogin: comment.authorLogin,
        createdAt: `2026-04-15T00:00:0${index}.000Z`,
      })),
    })),
  };
}
