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
      const command = input.args.join(" ");

      if (command.includes("query PullRequestRead")) {
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
                },
              },
            },
          }),
          stderr: "",
        };
      }

      if (command.includes("/files?")) {
        return {
          stdout: JSON.stringify([
            {
              filename: "src/index.ts",
              additions: 10,
              deletions: 1,
              status: "modified",
            },
          ]),
          stderr: "",
        };
      }

      if (command.includes("/reviews?")) {
        return {
          stdout: JSON.stringify([]),
          stderr: "",
        };
      }

      if (command.includes("query PullRequestThreads")) {
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
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
                      },
                    ],
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null,
                    },
                  },
                },
              },
            },
          }),
          stderr: "",
        };
      }

      if (command.includes("query ReviewThreadComments")) {
        return {
          stdout: JSON.stringify({
            data: {
              node: {
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
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null,
                  },
                },
              },
            },
          }),
          stderr: "",
        };
      }

      return {
        stdout: JSON.stringify([]),
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

  assert.ok(calls.length >= 4);
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

test("readPullRequest paginates files, reviews, threads, and thread comments", async () => {
  const calls: string[][] = [];
  const client = new GitHubCliClient({
    cwd: "/repo",
    env: {},
    run: async (input) => {
      calls.push(input.args);
      const command = input.args.join(" ");

      if (command.includes("query PullRequestRead")) {
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
                },
              },
            },
          }),
          stderr: "",
        };
      }

      if (command.includes("/files?")) {
        const pageArg = input.args.find((arg) => arg.includes("/files?")) ?? "";
        const page = new URL(pageArg, "https://github.local").searchParams.get("page");
        return {
          stdout: JSON.stringify(
            page === "1"
              ? new Array(100).fill(null).map((_, index) => ({
                  filename: `src/file-${index}.ts`,
                  additions: 1,
                  deletions: 0,
                  status: "modified",
                }))
              : [
                  {
                    filename: "src/file-100.ts",
                    additions: 2,
                    deletions: 1,
                    status: "modified",
                  },
                ],
          ),
          stderr: "",
        };
      }

      if (command.includes("/reviews?")) {
        const pageArg =
          input.args.find((arg) => arg.includes("/reviews?")) ?? "";
        const page = new URL(pageArg, "https://github.local").searchParams.get("page");
        return {
          stdout: JSON.stringify(
            page === "1"
              ? new Array(100).fill(null).map((_, index) => ({
                  id: index + 1,
                  node_id: `review-node-${index + 1}`,
                  state: "COMMENTED",
                  body: `Review ${index + 1}`,
                  html_url: `https://github.com/review/${index + 1}`,
                  submitted_at: "2026-04-15T19:00:00.000Z",
                  user: {
                    login: "reviewer",
                  },
                }))
              : [
                  {
                    id: 101,
                    node_id: "review-node-101",
                    state: "APPROVED",
                    body: "Final review",
                    html_url: "https://github.com/review/101",
                    submitted_at: "2026-04-15T20:00:00.000Z",
                    user: {
                      login: "reviewer",
                    },
                  },
                ],
          ),
          stderr: "",
        };
      }

      if (command.includes("query PullRequestThreads")) {
        const cursorArg = input.args.find((arg) => arg.startsWith("cursor="));
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: cursorArg === undefined
                    ? {
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
                          },
                        ],
                        pageInfo: {
                          hasNextPage: true,
                          endCursor: "thread-cursor-1",
                        },
                      }
                    : {
                        nodes: [
                          {
                            id: "thread-2",
                            isResolved: true,
                            isOutdated: false,
                            path: "src/github/client.ts",
                            line: 30,
                            originalLine: 30,
                            startLine: null,
                            originalStartLine: null,
                            diffSide: "RIGHT",
                          },
                        ],
                        pageInfo: {
                          hasNextPage: false,
                          endCursor: null,
                        },
                      },
                },
              },
            },
          }),
          stderr: "",
        };
      }

      if (command.includes("query ReviewThreadComments")) {
        const threadIdArg = input.args.find((arg) => arg.startsWith("threadId="));
        const cursorArg = input.args.find((arg) => arg.startsWith("cursor="));
        if (threadIdArg === "threadId=thread-1" && cursorArg === undefined) {
          return {
            stdout: JSON.stringify({
              data: {
                node: {
                  comments: {
                    nodes: new Array(100).fill(null).map((_, index) => ({
                      id: `comment-${index + 1}`,
                      databaseId: index + 1,
                      url: `https://github.com/comment/${index + 1}`,
                      body: `Comment ${index + 1}`,
                      createdAt: "2026-04-15T19:00:00.000Z",
                      author: {
                        login: "reviewer",
                      },
                    })),
                    pageInfo: {
                      hasNextPage: true,
                      endCursor: "comment-cursor-1",
                    },
                  },
                },
              },
            }),
            stderr: "",
          };
        }

        if (threadIdArg === "threadId=thread-1" && cursorArg === "cursor=comment-cursor-1") {
          return {
            stdout: JSON.stringify({
              data: {
                node: {
                  comments: {
                    nodes: [
                      {
                        id: "comment-101",
                        databaseId: 101,
                        url: "https://github.com/comment/101",
                        body: "Comment 101",
                        createdAt: "2026-04-15T19:05:00.000Z",
                        author: {
                          login: "reviewer",
                        },
                      },
                    ],
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null,
                    },
                  },
                },
              },
            }),
            stderr: "",
          };
        }

        return {
          stdout: JSON.stringify({
            data: {
              node: {
                comments: {
                  nodes: [
                    {
                      id: "thread-2-comment-1",
                      databaseId: 201,
                      url: "https://github.com/comment/201",
                      body: "Thread 2 comment",
                      createdAt: "2026-04-15T19:06:00.000Z",
                      author: {
                        login: "reviewer",
                      },
                    },
                  ],
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null,
                  },
                },
              },
            },
          }),
          stderr: "",
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    },
  });

  const result = await client.readPullRequest({
    owner: "kimballh",
    repo: "orqestrate",
    number: 42,
    url: "https://github.com/kimballh/orqestrate/pull/42",
  });

  assert.equal(result.files.length, 101);
  assert.equal(result.reviews.length, 101);
  assert.equal(result.threads.length, 2);
  assert.equal(result.threads[0]?.comments.length, 101);
  assert.equal(result.threads[1]?.comments.length, 1);
  assert.ok(calls.some((args) => args.some((arg) => arg === "cursor=thread-cursor-1")));
  assert.ok(calls.some((args) => args.some((arg) => arg === "cursor=comment-cursor-1")));
});
