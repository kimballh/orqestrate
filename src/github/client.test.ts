import assert from "node:assert/strict";
import test from "node:test";

import { GitHubCliClient } from "./client.js";

test("readPullRequest parses GraphQL payloads into stable output", async () => {
  const calls: string[][] = [];
  const client = new GitHubCliClient({
    cwd: "/repo",
    env: {},
    run: async (input) => {
      calls.push(input.args);
      return {
        stdout: JSON.stringify({
          data: {
            viewer: {
              login: "reviewer",
            },
            repository: {
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
                author: {
                  login: "kimballh",
                },
                files: {
                  nodes: [
                    {
                      path: "src/index.ts",
                      additions: 10,
                      deletions: 1,
                      changeType: "MODIFIED",
                    },
                  ],
                },
                reviews: {
                  nodes: [],
                },
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread-1",
                      isResolved: false,
                      isOutdated: false,
                      path: "src/index.ts",
                      line: 12,
                      originalLine: 12,
                      startLine: null,
                      originalStartLine: null,
                      diffSide: "RIGHT",
                      comments: {
                        nodes: [
                          {
                            id: "comment-1",
                            databaseId: 101,
                            url: "https://github.com/comment",
                            body: "Needs a test",
                            createdAt: "2026-04-15T19:00:00.000Z",
                            author: {
                              login: "reviewer",
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
        stderr: "",
      };
    },
  });

  const result = await client.readPullRequest({
    owner: "kimballh",
    repo: "orqestrate",
    number: 42,
    url: "https://github.com/kimballh/orqestrate/pull/42",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], "api");
  assert.equal(result.viewerLogin, "reviewer");
  assert.equal(result.pullRequest.number, 42);
  assert.equal(result.threads[0]?.comments[0]?.databaseId, 101);
});

test("submitReview includes inline comment payload arguments", async () => {
  const calls: string[][] = [];
  const client = new GitHubCliClient({
    cwd: "/repo",
    env: {},
    run: async (input) => {
      calls.push(input.args);
      return {
        stdout: JSON.stringify({
          id: 55,
          html_url: "https://github.com/kimballh/orqestrate/pull/42#pullrequestreview-55",
          body: "Looks good",
          state: "COMMENTED",
          submitted_at: "2026-04-15T19:00:00.000Z",
        }),
        stderr: "",
      };
    },
  });

  const result = await client.submitReview({
    repo: {
      owner: "kimballh",
      repo: "orqestrate",
    },
    pullRequestNumber: 42,
    body: "Looks good",
    event: "COMMENT",
    comments: [
      {
        path: "src/index.ts",
        line: 12,
        body: "Inline note",
      },
    ],
  });

  const args = calls[0] ?? [];
  assert.ok(args.includes("comments[][path]=src/index.ts"));
  assert.ok(args.includes("comments[][body]=Inline note"));
  assert.equal(result.id, 55);
});
