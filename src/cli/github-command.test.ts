import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../index.js";
import {
  parsePullRequestReviewLoopMarker,
  stripPullRequestReviewLoopMarkers,
} from "../github/review-loop.js";

test("top-level help includes the github command", async () => {
  const result = await invokeCli(["--help"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /github\s+Run bounded GitHub PR interactions/);
});

test("github pr-read prints the linked pull request summary", async () => {
  const result = await invokeCli(["github", "pr-read"], {
    loadRun: async () => createRun(),
    createClient: () =>
      ({
        readPullRequest: async () => ({
          viewerLogin: "reviewer",
          pullRequest: {
            id: "PR_kwDO",
            number: 42,
            title: "Implement ORQ-42",
            url: "https://github.com/kimballh/orqestrate/pull/42",
            state: "OPEN",
            isDraft: false,
            body: "Body",
            baseRefName: "main",
            headRefName: "hillkimball/orq-42",
            reviewDecision: "REVIEW_REQUIRED",
            authorLogin: "kimballh",
          },
          files: [],
          reviews: [],
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
              comments: [],
            },
          ],
        }),
      }) as never,
  });

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.pullRequest.number, 42);
  assert.equal(parsed.unresolvedThreadCount, 1);
});

test("github review-thread-resolve rejects missing capabilities with structured stderr", async () => {
  const result = await invokeCli(
    ["github", "review-thread-resolve", "--thread-id", "thread-1"],
    {
      loadRun: async () =>
        createRun({
          grantedCapabilities: ["github.read_pr"],
        }),
      createClient: () => ({}) as never,
    },
  );

  assert.equal(result.exitCode, 1);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.error.code, "missing_capability");
});

test("github pr-upsert creates a pull request on the assigned branch when none exists", async () => {
  const events: string[] = [];
  const result = await invokeCli(
    [
      "github",
      "pr-upsert",
      "--title",
      "Implement ORQ-42",
      "--body",
      "Adds GitHub gating.",
    ],
    {
      loadRun: async () =>
        createRun({
          workspace: {
            pullRequestUrl: null,
            assignedBranch: "refs/heads/hillkimball/orq-42",
          },
        }),
      getOriginRemoteUrl: async () => "git@github.com:kimballh/orqestrate.git",
      createClient: () =>
        ({
          findOpenPullRequestForBranch: async ({ headBranch }: { headBranch: string }) => {
            events.push(`find:${headBranch}`);
            return null;
          },
          createPullRequest: async ({ headBranch }: { headBranch: string }) => {
            events.push(`create:${headBranch}`);
            return {
              action: "created",
              pullRequest: {
                number: 42,
                title: "Implement ORQ-42",
                url: "https://github.com/kimballh/orqestrate/pull/42",
                body: "Adds GitHub gating.",
                headRefName: headBranch,
                baseRefName: "main",
                authorLogin: "kimballh",
              },
            };
          },
        }) as never,
    },
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(events, ["find:hillkimball/orq-42", "create:hillkimball/orq-42"]);
});

test("github review-write degrades to comment-only when the reviewer matches the PR author", async () => {
  const result = await invokeCli(
    ["github", "review-write", "--body", "No blocking findings.", "--event", "approve"],
    {
      loadRun: async () => createRun({
        grantedCapabilities: ["github.write_review"],
      }),
      createClient: () =>
        ({
          getPullRequestSummary: async () => ({
            number: 42,
            title: "Implement ORQ-42",
            url: "https://github.com/kimballh/orqestrate/pull/42",
            body: "Adds GitHub gating.",
            headRefName: "hillkimball/orq-42",
            baseRefName: "main",
            authorLogin: "kimballh",
          }),
          getViewerLogin: async () => "kimballh",
          submitReview: async ({ event }: { event: string }) => ({
            id: 12,
            url: "https://github.com/kimballh/orqestrate/pull/42#pullrequestreview-12",
            body: "No blocking findings.",
            state: event,
            submittedAt: "2026-04-15T20:00:00.000Z",
          }),
        }) as never,
    },
  );

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.degradedToCommentOnly, true);
  assert.equal(parsed.eventApplied, "COMMENT");
});

test("github subcommand help does not require runtime context", async () => {
  const result = await runCli(["github", "pr-read", "--help"], {
    cwd: () => "/repo",
    env: {},
    stdout: () => undefined,
    stderr: () => undefined,
  });

  assert.equal(result, 0);
});

test("github subcommand help prints usage text instead of runtime errors", async () => {
  const result = await invokeCli(["github", "review-thread-reply", "--help"], {
    loadRun: async () => {
      throw new Error("runtime should not be loaded for help");
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /github review-thread-reply --thread-id <id> --body <body>/);
  assert.equal(result.stderr, "");
});

test("github review-thread-reply allows --help as the body value", async () => {
  const result = await invokeCli(
    [
      "github",
      "review-thread-reply",
      "--thread-id",
      "thread-1",
      "--body",
      "--help",
    ],
    {
      loadRun: async () => createRun(),
      createClient: () =>
        ({
          getReviewThread: async () => ({
            id: "thread-1",
            pullRequest: {
              owner: "kimballh",
              repo: "orqestrate",
              number: 42,
              url: "https://github.com/kimballh/orqestrate/pull/42",
            },
            comments: [
              {
                id: "comment-1",
                databaseId: 101,
                url: "https://github.com/comment/101",
                body: "Needs a reply",
                createdAt: "2026-04-15T20:00:00.000Z",
                authorLogin: "reviewer",
              },
            ],
          }),
          replyToReviewComment: async ({ body }: { body: string }) => ({
            id: 12,
            url: "https://github.com/kimballh/orqestrate/pull/42#discussion_r12",
            body,
          }),
        }) as never,
    },
  );

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(stripPullRequestReviewLoopMarkers(parsed.reply.body), "--help");
  assert.deepEqual(parsePullRequestReviewLoopMarker(parsed.reply.body), {
    runId: "run-001",
    phase: "implement",
    role: "implement",
    threadId: "thread-1",
  });
});

test("github review-write appends machine markers to review bodies", async () => {
  let submittedBody = "";
  let submittedInlineBody = "";
  const result = await invokeCli(
    [
      "github",
      "review-write",
      "--body",
      "No blocking findings.",
      "--comment-json",
      JSON.stringify({
        path: "src/index.ts",
        line: 10,
        body: "Please add a regression test here.",
      }),
    ],
    {
      loadRun: async () =>
        createRun({
          grantedCapabilities: ["github.write_review"],
        }),
      createClient: () =>
        ({
          getPullRequestSummary: async () => ({
            number: 42,
            title: "Implement ORQ-42",
            url: "https://github.com/kimballh/orqestrate/pull/42",
            body: "Adds GitHub gating.",
            headRefName: "hillkimball/orq-42",
            baseRefName: "main",
            authorLogin: "reviewer",
          }),
          getViewerLogin: async () => "kimballh",
          submitReview: async ({
            body,
            comments,
          }: {
            body: string;
            comments: Array<{ body: string }>;
          }) => {
            submittedBody = body;
            submittedInlineBody = comments[0]?.body ?? "";
            return {
              id: 12,
              url: "https://github.com/kimballh/orqestrate/pull/42#pullrequestreview-12",
              body,
              state: "COMMENTED",
              submittedAt: "2026-04-15T20:00:00.000Z",
            };
          },
        }) as never,
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(stripPullRequestReviewLoopMarkers(submittedBody), "No blocking findings.");
  assert.equal(
    stripPullRequestReviewLoopMarkers(submittedInlineBody),
    "Please add a regression test here.",
  );
  assert.deepEqual(parsePullRequestReviewLoopMarker(submittedBody), {
    runId: "run-001",
    phase: "review",
    role: "review",
    threadId: null,
  });
});

test("github pr-merge dry-run reports merge readiness through policy", async () => {
  const result = await invokeCli(["github", "pr-merge", "--dry-run"], {
    loadRun: async () =>
      createRun({
        grantedCapabilities: ["github.merge_pr"],
      }),
    loadConfig: async () =>
      ({
        policy: {
          merge: {
            allowedMethods: ["squash"],
            requireHumanApproval: false,
          },
        },
      }) as never,
    createClient: () =>
      ({
        readPullRequest: async () => ({
          viewerLogin: "reviewer",
          pullRequest: {
            id: "PR_kwDO44",
            number: 44,
            title: "Implement ORQ-44",
            url: "https://github.com/kimballh/orqestrate/pull/42",
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
          threads: [],
        }),
        readPullRequestMergeReadiness: async () => ({
          pullRequest: {
            id: "PR_kwDO44",
            number: 44,
            url: "https://github.com/kimballh/orqestrate/pull/42",
            state: "OPEN",
            isDraft: false,
            reviewDecision: "APPROVED",
            mergeStateStatus: "CLEAN",
            mergeable: "MERGEABLE",
            merged: false,
            mergedAt: null,
            headRefOid: "abc123",
          },
          statusCheckRollupState: "SUCCESS",
          requiredChecks: [],
        }),
      }) as never,
  });

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision.disposition, "ready_to_execute");
  assert.equal(parsed.decision.mergeMethod, "squash");
});

test("github pr-merge executes a bounded merge when policy allows it", async () => {
  let matchedHeadCommit = "";
  const result = await invokeCli(
    ["github", "pr-merge", "--method", "squash", "--human-approved"],
    {
      loadRun: async () =>
        createRun({
          grantedCapabilities: ["github.merge_pr"],
        }),
      loadConfig: async () =>
        ({
          policy: {
            merge: {
              allowedMethods: ["squash"],
              requireHumanApproval: false,
            },
          },
        }) as never,
      createClient: () =>
        ({
          readPullRequest: async () => ({
            viewerLogin: "reviewer",
            pullRequest: {
              id: "PR_kwDO44",
              number: 44,
              title: "Implement ORQ-44",
              url: "https://github.com/kimballh/orqestrate/pull/42",
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
            threads: [],
          }),
          readPullRequestMergeReadiness: async () => ({
            pullRequest: {
              id: "PR_kwDO44",
              number: 44,
              url: "https://github.com/kimballh/orqestrate/pull/42",
              state: "OPEN",
              isDraft: false,
              reviewDecision: "APPROVED",
              mergeStateStatus: "CLEAN",
              mergeable: "MERGEABLE",
              merged: false,
              mergedAt: null,
              headRefOid: "abc123",
            },
            statusCheckRollupState: "SUCCESS",
            requiredChecks: [],
          }),
          mergePullRequest: async ({ matchHeadCommit }: { matchHeadCommit: string }) => {
            matchedHeadCommit = matchHeadCommit;
            return {
              method: "squash",
              pullRequest: {
                id: "PR_kwDO44",
                number: 44,
                url: "https://github.com/kimballh/orqestrate/pull/42",
                state: "MERGED",
                isDraft: false,
                reviewDecision: "APPROVED",
                mergeStateStatus: "CLEAN",
                mergeable: "MERGEABLE",
                merged: true,
                mergedAt: "2026-04-15T22:00:00.000Z",
                headRefOid: "abc123",
              },
            };
          },
        }) as never,
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(matchedHeadCommit, "abc123");
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.merge.pullRequest.state, "MERGED");
});

async function invokeCli(
  args: string[],
  dependencies: {
    loadRun?: (env: NodeJS.ProcessEnv) => Promise<unknown>;
    loadConfig?: (...args: unknown[]) => Promise<unknown>;
    createClient?: (cwd: string, env: NodeJS.ProcessEnv) => unknown;
    getOriginRemoteUrl?: (cwd: string) => Promise<string>;
  } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(args, {
    cwd: () => "/repo",
    env: {
      ORQ_RUN_ID: "run-001",
      ORQ_RUNTIME_API_ENDPOINT: "unix:///tmp/orq/runtime.sock",
    },
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
    loadRun: dependencies.loadRun as never,
    loadConfig: dependencies.loadConfig as never,
    createClient: dependencies.createClient as never,
    getOriginRemoteUrl: dependencies.getOriginRemoteUrl,
  });

  return {
    exitCode,
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
  };
}

function createRun(overrides: {
  grantedCapabilities?: string[];
  workspace?: {
    pullRequestUrl?: string | null;
    assignedBranch?: string | null;
    writeScope?: string | null;
  };
} = {}) {
  return {
    runId: "run-001",
    grantedCapabilities:
      overrides.grantedCapabilities ?? [
        "github.read_pr",
        "github.create_pr",
        "github.merge_pr",
        "github.reply_review_thread",
        "github.resolve_review_thread",
        "github.write_review",
      ],
    workspace: {
      repoRoot: "/repo",
      mode: "ephemeral_worktree",
      pullRequestUrl:
        overrides.workspace?.pullRequestUrl !== undefined
          ? overrides.workspace.pullRequestUrl
          : "https://github.com/kimballh/orqestrate/pull/42",
      assignedBranch:
        overrides.workspace?.assignedBranch !== undefined
          ? overrides.workspace.assignedBranch
          : "hillkimball/orq-42",
      writeScope:
        overrides.workspace?.writeScope !== undefined
          ? overrides.workspace.writeScope
          : "repo",
    },
  };
}
