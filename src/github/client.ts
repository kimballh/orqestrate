import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

import type { GitHubRepoRef, PullRequestRef } from "./scope.js";

const execFileAsync = promisify(execFile);

export type GitHubReviewCommentInput = {
  path: string;
  line: number;
  body: string;
  side?: "LEFT" | "RIGHT";
};

export type GitHubPullRequestThreadComment = {
  id: string;
  databaseId: number | null;
  url: string;
  body: string;
  authorLogin: string | null;
  createdAt: string | null;
};

export type GitHubPullRequestThread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  originalStartLine: number | null;
  diffSide: string | null;
  comments: GitHubPullRequestThreadComment[];
};

export type GitHubPullRequestReadResult = {
  viewerLogin: string | null;
  pullRequest: {
    id: string;
    number: number;
    title: string;
    url: string;
    state: string;
    isDraft: boolean;
    body: string | null;
    baseRefName: string;
    headRefName: string;
    reviewDecision: string | null;
    authorLogin: string | null;
  };
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    changeType: string;
  }>;
  reviews: Array<{
    id: string;
    state: string;
    body: string | null;
    url: string | null;
    submittedAt: string | null;
    authorLogin: string | null;
  }>;
  threads: GitHubPullRequestThread[];
};

export type GitHubReviewThreadRef = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  pullRequest: PullRequestRef & {
    authorLogin: string | null;
    headRefName: string | null;
  };
  comments: GitHubPullRequestThreadComment[];
};

export type GitHubPullRequestSummary = {
  number: number;
  title: string;
  url: string;
  body: string | null;
  headRefName: string;
  baseRefName: string;
  authorLogin: string | null;
};

export type GitHubPullRequestMutationResult = {
  action: "created" | "updated";
  pullRequest: GitHubPullRequestSummary;
};

export type GitHubReplyResult = {
  id: number;
  url: string;
  body: string;
};

export type GitHubResolveReviewThreadResult = {
  id: string;
  isResolved: boolean;
};

export type GitHubReviewWriteResult = {
  id: number;
  url: string | null;
  body: string | null;
  state: string | null;
  submittedAt: string | null;
};

export type GitHubCliRunner = (input: {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => Promise<{
  stdout: string;
  stderr: string;
}>;

export class GitHubClientError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | null;

  constructor(
    message: string,
    input: {
      code: string;
      details?: Record<string, unknown> | null;
    },
  ) {
    super(message);
    this.name = "GitHubClientError";
    this.code = input.code;
    this.details = input.details ?? null;
  }
}

export type GitHubClientDependencies = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  run?: GitHubCliRunner;
};

export class GitHubCliClient {
  readonly #cwd: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #run: GitHubCliRunner;

  constructor(dependencies: GitHubClientDependencies) {
    this.#cwd = dependencies.cwd;
    this.#env = dependencies.env ?? process.env;
    this.#run = dependencies.run ?? defaultGitHubCliRunner;
  }

  async readPullRequest(
    pullRequest: PullRequestRef,
  ): Promise<GitHubPullRequestReadResult> {
    const response = await this.#runGraphql<{
      repository: {
        pullRequest: {
          id: string;
          number: number;
          title: string;
          url: string;
          state: string;
          isDraft: boolean;
          body: string | null;
          baseRefName: string;
          headRefName: string;
          reviewDecision: string | null;
          author: { login: string } | null;
          files: {
            nodes: Array<{
              path: string;
              additions: number;
              deletions: number;
              changeType: string;
            }>;
          };
          reviews: {
            nodes: Array<{
              id: string;
              state: string;
              body: string | null;
              url: string | null;
              submittedAt: string | null;
              author: { login: string } | null;
            }>;
          };
          reviewThreads: {
            nodes: Array<{
              id: string;
              isResolved: boolean;
              isOutdated: boolean;
              path: string | null;
              line: number | null;
              originalLine: number | null;
              startLine: number | null;
              originalStartLine: number | null;
              diffSide: string | null;
              comments: {
                nodes: Array<{
                  id: string;
                  databaseId: number | null;
                  url: string;
                  body: string;
                  createdAt: string | null;
                  author: { login: string } | null;
                }>;
              };
            }>;
          };
        } | null;
      } | null;
      viewer: { login: string } | null;
    }>(
      `
        query PullRequestRead(
          $owner: String!
          $repo: String!
          $number: Int!
        ) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              id
              number
              title
              url
              state
              isDraft
              body
              baseRefName
              headRefName
              reviewDecision
              author {
                login
              }
              files(first: 100) {
                nodes {
                  path
                  additions
                  deletions
                  changeType
                }
              }
              reviews(first: 100) {
                nodes {
                  id
                  state
                  body
                  url
                  submittedAt
                  author {
                    login
                  }
                }
              }
              reviewThreads(first: 100) {
                nodes {
                  id
                  isResolved
                  isOutdated
                  path
                  line
                  originalLine
                  startLine
                  originalStartLine
                  diffSide
                  comments(first: 100) {
                    nodes {
                      id
                      databaseId
                      url
                      body
                      createdAt
                      author {
                        login
                      }
                    }
                  }
                }
              }
            }
          }
          viewer {
            login
          }
        }
      `,
      {
        owner: pullRequest.owner,
        repo: pullRequest.repo,
        number: pullRequest.number,
      },
    );

    const payload = response.repository?.pullRequest;
    if (payload === null || payload === undefined) {
      throw new GitHubClientError(
        `Pull request '${pullRequest.url}' was not found in GitHub.`,
        {
          code: "not_found",
          details: {
            pullRequestUrl: pullRequest.url,
          },
        },
      );
    }

    return {
      viewerLogin: response.viewer?.login ?? null,
      pullRequest: {
        id: payload.id,
        number: payload.number,
        title: payload.title,
        url: payload.url,
        state: payload.state,
        isDraft: payload.isDraft,
        body: payload.body,
        baseRefName: payload.baseRefName,
        headRefName: payload.headRefName,
        reviewDecision: payload.reviewDecision,
        authorLogin: payload.author?.login ?? null,
      },
      files: payload.files.nodes,
      reviews: payload.reviews.nodes.map((review) => ({
        id: review.id,
        state: review.state,
        body: review.body,
        url: review.url,
        submittedAt: review.submittedAt,
        authorLogin: review.author?.login ?? null,
      })),
      threads: payload.reviewThreads.nodes.map((thread) => ({
        id: thread.id,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        path: thread.path,
        line: thread.line,
        originalLine: thread.originalLine,
        startLine: thread.startLine,
        originalStartLine: thread.originalStartLine,
        diffSide: thread.diffSide,
        comments: thread.comments.nodes.map((comment) => ({
          id: comment.id,
          databaseId: comment.databaseId,
          url: comment.url,
          body: comment.body,
          createdAt: comment.createdAt,
          authorLogin: comment.author?.login ?? null,
        })),
      })),
    };
  }

  async getReviewThread(threadId: string): Promise<GitHubReviewThreadRef> {
    const response = await this.#runGraphql<{
      node:
        | {
            id: string;
            isResolved: boolean;
            isOutdated: boolean;
            path: string | null;
            line: number | null;
            pullRequest: {
              number: number;
              url: string;
              headRefName: string;
              author: { login: string } | null;
              repository: {
                name: string;
                owner: { login: string };
              };
            };
            comments: {
              nodes: Array<{
                id: string;
                databaseId: number | null;
                url: string;
                body: string;
                createdAt: string | null;
                author: { login: string } | null;
              }>;
            };
          }
        | null;
    }>(
      `
        query ReviewThread($threadId: ID!) {
          node(id: $threadId) {
            ... on PullRequestReviewThread {
              id
              isResolved
              isOutdated
              path
              line
              pullRequest {
                number
                url
                headRefName
                author {
                  login
                }
                repository {
                  name
                  owner {
                    login
                  }
                }
              }
              comments(first: 100) {
                nodes {
                  id
                  databaseId
                  url
                  body
                  createdAt
                  author {
                    login
                  }
                }
              }
            }
          }
        }
      `,
      {
        threadId,
      },
    );

    if (response.node === null || response.node === undefined) {
      throw new GitHubClientError(
        `Review thread '${threadId}' was not found in GitHub.`,
        {
          code: "not_found",
          details: {
            threadId,
          },
        },
      );
    }

    return {
      id: response.node.id,
      isResolved: response.node.isResolved,
      isOutdated: response.node.isOutdated,
      path: response.node.path,
      line: response.node.line,
      pullRequest: {
        owner: response.node.pullRequest.repository.owner.login,
        repo: response.node.pullRequest.repository.name,
        number: response.node.pullRequest.number,
        url: response.node.pullRequest.url,
        authorLogin: response.node.pullRequest.author?.login ?? null,
        headRefName: response.node.pullRequest.headRefName,
      },
      comments: response.node.comments.nodes.map((comment) => ({
        id: comment.id,
        databaseId: comment.databaseId,
        url: comment.url,
        body: comment.body,
        createdAt: comment.createdAt,
        authorLogin: comment.author?.login ?? null,
      })),
    };
  }

  async findOpenPullRequestForBranch(input: {
    repo: GitHubRepoRef;
    headBranch: string;
  }): Promise<GitHubPullRequestSummary | null> {
    const response = await this.#runJson<Array<{
      number: number;
      title: string;
      url: string;
      body: string | null;
      headRefName: string;
      baseRefName: string;
    }>>([
      "pr",
      "list",
      "--repo",
      formatRepo(input.repo),
      "--state",
      "open",
      "--head",
      input.headBranch,
      "--json",
      "number,title,url,body,headRefName,baseRefName",
    ]);

    const pullRequest = response[0];
    if (pullRequest === undefined) {
      return null;
    }

    return {
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      body: pullRequest.body,
      headRefName: pullRequest.headRefName,
      baseRefName: pullRequest.baseRefName,
      authorLogin: null,
    };
  }

  async updatePullRequest(input: {
    pullRequest: PullRequestRef;
    title: string;
    body: string;
  }): Promise<GitHubPullRequestMutationResult> {
    await this.#runText([
      "pr",
      "edit",
      String(input.pullRequest.number),
      "--repo",
      formatRepo(input.pullRequest),
      "--title",
      input.title,
      "--body",
      input.body,
    ]);

    return {
      action: "updated",
      pullRequest: await this.getPullRequestSummary(input.pullRequest),
    };
  }

  async createPullRequest(input: {
    repo: GitHubRepoRef;
    headBranch: string;
    title: string;
    body: string;
    baseBranch?: string | null;
  }): Promise<GitHubPullRequestMutationResult> {
    const args = [
      "pr",
      "create",
      "--repo",
      formatRepo(input.repo),
      "--head",
      input.headBranch,
      "--title",
      input.title,
      "--body",
      input.body,
    ];
    if (input.baseBranch !== undefined && input.baseBranch !== null) {
      args.push("--base", input.baseBranch);
    }

    const url = (await this.#runText(args)).trim();
    const pullRequest = await this.getPullRequestSummaryFromUrl(url);
    return {
      action: "created",
      pullRequest,
    };
  }

  async getPullRequestSummary(
    pullRequest: PullRequestRef,
  ): Promise<GitHubPullRequestSummary> {
    const response = await this.#runJson<{
      number: number;
      title: string;
      url: string;
      body: string | null;
      headRefName: string;
      baseRefName: string;
      author: { login: string } | null;
    }>([
      "pr",
      "view",
      String(pullRequest.number),
      "--repo",
      formatRepo(pullRequest),
      "--json",
      "number,title,url,body,headRefName,baseRefName,author",
    ]);

    return {
      number: response.number,
      title: response.title,
      url: response.url,
      body: response.body,
      headRefName: response.headRefName,
      baseRefName: response.baseRefName,
      authorLogin: response.author?.login ?? null,
    };
  }

  async getPullRequestSummaryFromUrl(
    pullRequestUrl: string,
  ): Promise<GitHubPullRequestSummary> {
    const response = await this.#runJson<{
      number: number;
      title: string;
      url: string;
      body: string | null;
      headRefName: string;
      baseRefName: string;
      author: { login: string } | null;
    }>([
      "pr",
      "view",
      pullRequestUrl,
      "--json",
      "number,title,url,body,headRefName,baseRefName,author",
    ]);

    return {
      number: response.number,
      title: response.title,
      url: response.url,
      body: response.body,
      headRefName: response.headRefName,
      baseRefName: response.baseRefName,
      authorLogin: response.author?.login ?? null,
    };
  }

  async replyToReviewComment(input: {
    repo: GitHubRepoRef;
    pullRequestNumber: number;
    commentId: number;
    body: string;
  }): Promise<GitHubReplyResult> {
    const response = await this.#runJson<{
      id: number;
      html_url: string;
      body: string;
    }>([
      "api",
      "--method",
      "POST",
      `repos/${formatRepo(input.repo)}/pulls/${input.pullRequestNumber}/comments/${input.commentId}/replies`,
      "-f",
      `body=${input.body}`,
    ]);

    return {
      id: response.id,
      url: response.html_url,
      body: response.body,
    };
  }

  async resolveReviewThread(
    threadId: string,
  ): Promise<GitHubResolveReviewThreadResult> {
    const response = await this.#runGraphql<{
      resolveReviewThread: {
        thread: {
          id: string;
          isResolved: boolean;
        } | null;
      } | null;
    }>(
      `
        mutation ResolveReviewThread($threadId: ID!) {
          resolveReviewThread(input: { threadId: $threadId }) {
            thread {
              id
              isResolved
            }
          }
        }
      `,
      {
        threadId,
      },
    );

    const thread = response.resolveReviewThread?.thread;
    if (thread === null || thread === undefined) {
      throw new GitHubClientError(
        `GitHub did not return an updated thread for '${threadId}'.`,
        {
          code: "transport_failure",
          details: {
            threadId,
          },
        },
      );
    }

    return thread;
  }

  async submitReview(input: {
    repo: GitHubRepoRef;
    pullRequestNumber: number;
    body: string;
    event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
    comments?: GitHubReviewCommentInput[];
  }): Promise<GitHubReviewWriteResult> {
    const args = [
      "api",
      "--method",
      "POST",
      `repos/${formatRepo(input.repo)}/pulls/${input.pullRequestNumber}/reviews`,
      "-f",
      `body=${input.body}`,
      "-f",
      `event=${input.event}`,
    ];

    for (const comment of input.comments ?? []) {
      args.push("-f", `comments[][path]=${comment.path}`);
      args.push("-F", `comments[][line]=${comment.line}`);
      args.push("-f", `comments[][body]=${comment.body}`);
      args.push("-f", `comments[][side]=${comment.side ?? "RIGHT"}`);
    }

    const response = await this.#runJson<{
      id: number;
      html_url: string | null;
      body: string | null;
      state: string | null;
      submitted_at: string | null;
    }>(args);

    return {
      id: response.id,
      url: response.html_url,
      body: response.body,
      state: response.state,
      submittedAt: response.submitted_at,
    };
  }

  async getViewerLogin(): Promise<string | null> {
    const response = await this.#runJson<{
      login: string;
    }>(["api", "user"]);
    return response.login;
  }

  async #runJson<T>(args: string[]): Promise<T> {
    const stdout = await this.#runText(args);
    try {
      return JSON.parse(stdout) as T;
    } catch (error) {
      throw new GitHubClientError(
        "GitHub CLI returned an invalid JSON payload.",
        {
          code: "invalid_response",
          details: {
            args,
            cause: error instanceof Error ? error.message : String(error),
          },
        },
      );
    }
  }

  async #runGraphql<T>(
    query: string,
    variables: Record<string, string | number>,
  ): Promise<T> {
    const args = ["api", "graphql", "-f", `query=${compactGraphql(query)}`];

    for (const [key, value] of Object.entries(variables)) {
      const flag = typeof value === "number" ? "-F" : "-f";
      args.push(flag, `${key}=${String(value)}`);
    }

    const response = await this.#runJson<{
      data?: T;
      errors?: Array<{ message: string }>;
    }>(args);

    if (response.errors !== undefined && response.errors.length > 0) {
      throw new GitHubClientError(
        response.errors[0]?.message ?? "GitHub GraphQL request failed.",
        {
          code: "graphql_error",
          details: {
            errors: response.errors,
          },
        },
      );
    }

    if (response.data === undefined) {
      throw new GitHubClientError(
        "GitHub GraphQL request did not return a data payload.",
        {
          code: "invalid_response",
        },
      );
    }

    return response.data;
  }

  async #runText(args: string[]): Promise<string> {
    const response = await this.#run({
      args,
      cwd: this.#cwd,
      env: this.#env,
    });
    return response.stdout;
  }
}

async function defaultGitHubCliRunner(input: {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  stdout: string;
  stderr: string;
}> {
  try {
    const response = await execFileAsync("gh", input.args, {
      cwd: input.cwd,
      env: input.env,
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      stdout: response.stdout,
      stderr: response.stderr,
    };
  } catch (error) {
    const stderr =
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof error.stderr === "string"
        ? error.stderr
        : "";
    const code =
      error instanceof Error && "code" in error
        ? String(error.code)
        : "transport_failure";

    throw new GitHubClientError(
      buildGitHubCliFailureMessage(stderr, error),
      {
        code: classifyGitHubCliFailureCode(code, stderr),
        details: {
          args: input.args,
          stderr,
        },
      },
    );
  }
}

function classifyGitHubCliFailureCode(
  processCode: string,
  stderr: string,
): string {
  if (processCode === "ENOENT") {
    return "unavailable";
  }

  if (/not logged into any GitHub hosts/i.test(stderr)) {
    return "auth_missing";
  }

  if (/authentication failed/i.test(stderr)) {
    return "auth_missing";
  }

  return "transport_failure";
}

function buildGitHubCliFailureMessage(stderr: string, error: unknown): string {
  if (stderr.trim().length > 0) {
    return stderr.trim();
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "GitHub CLI execution failed.";
}

function compactGraphql(query: string): string {
  return query
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function formatRepo(repo: GitHubRepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}
