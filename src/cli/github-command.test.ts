import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../index.js";

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

async function invokeCli(
  args: string[],
  dependencies: {
    loadRun?: (env: NodeJS.ProcessEnv) => Promise<unknown>;
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
