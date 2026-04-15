import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

import type { MergeMethod } from "../config/types.js";
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

export type GitHubRequiredStatusCheck = {
  name: string;
  state: string;
  isRequired: boolean;
};

export type GitHubPullRequestMergeReadiness = {
  pullRequest: {
    id: string;
    number: number;
    url: string;
    state: string;
    isDraft: boolean;
    reviewDecision: string | null;
    mergeStateStatus: string | null;
    mergeable: string | null;
    merged: boolean;
    mergedAt: string | null;
    headRefOid: string | null;
  };
  statusCheckRollupState: string | null;
  requiredChecks: GitHubRequiredStatusCheck[];
};

export type GitHubPullRequestMergeResult = {
  method: MergeMethod;
  pullRequest: GitHubPullRequestMergeReadiness["pullRequest"];
};

export type GitHubReviewWriteResult = {
  id: number;
  url: string | null;
  body: string | null;
  state: string | null;
  submittedAt: string | null;
};

type GitHubPullRequestThreadsQuery = {
  repository: {
    pullRequest: {
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
        }>;
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
      };
    } | null;
  } | null;
};

type GitHubReviewThreadCommentsQuery = {
  node:
    | {
        comments: {
          nodes: Array<{
            id: string;
            databaseId: number | null;
            url: string;
            body: string;
            createdAt: string | null;
            author: { login: string } | null;
          }>;
          pageInfo: {
            hasNextPage: boolean;
            endCursor: string | null;
          };
        };
      }
    | null;
};

type GitHubPullRequestThreadsPage = NonNullable<
  NonNullable<GitHubPullRequestThreadsQuery["repository"]>["pullRequest"]
>["reviewThreads"];

type GitHubReviewThreadCommentsPage = NonNullable<
  GitHubReviewThreadCommentsQuery["node"]
>["comments"];

type GitHubPullRequestMergeReadinessQuery = {
  repository: {
    pullRequest: {
      id: string;
      number: number;
      url: string;
      state: string;
      isDraft: boolean;
      reviewDecision: string | null;
      mergeStateStatus: string | null;
      mergeable: string | null;
      merged: boolean;
      mergedAt: string | null;
      headRefOid: string | null;
      statusCheckRollup:
        | {
            state: string | null;
            contexts: {
              nodes: Array<
                | {
                    __typename: "CheckRun";
                    name: string;
                    status: string;
                    conclusion: string | null;
                    isRequired: boolean;
                  }
                | {
                    __typename: "StatusContext";
                    context: string;
                    state: string;
                    isRequired: boolean;
                  }
              >;
            };
          }
        | null;
    } | null;
  } | null;
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

    const [files, reviews, threads] = await Promise.all([
      this.#listPullRequestFiles(pullRequest),
      this.#listPullRequestReviews(pullRequest),
      this.#listPullRequestThreads(pullRequest),
    ]);

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
      files,
      reviews,
      threads,
    };
  }

  async readPullRequestMergeReadiness(
    pullRequest: PullRequestRef,
  ): Promise<GitHubPullRequestMergeReadiness> {
    const response = await this.#runGraphql<GitHubPullRequestMergeReadinessQuery>(
      `
        query PullRequestMergeReadiness(
          $owner: String!
          $repo: String!
          $number: Int!
        ) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              id
              number
              url
              state
              isDraft
              reviewDecision
              mergeStateStatus
              mergeable
              merged
              mergedAt
              headRefOid
              statusCheckRollup {
                state
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      status
                      conclusion
                      isRequired(pullRequestNumber: $number)
                    }
                    ... on StatusContext {
                      context
                      state
                      isRequired(pullRequestNumber: $number)
                    }
                  }
                }
              }
            }
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
      pullRequest: {
        id: payload.id,
        number: payload.number,
        url: payload.url,
        state: payload.state,
        isDraft: payload.isDraft,
        reviewDecision: payload.reviewDecision,
        mergeStateStatus: payload.mergeStateStatus,
        mergeable: payload.mergeable,
        merged: payload.merged,
        mergedAt: payload.mergedAt,
        headRefOid: payload.headRefOid,
      },
      statusCheckRollupState: payload.statusCheckRollup?.state ?? null,
      requiredChecks: (payload.statusCheckRollup?.contexts.nodes ?? [])
        .filter((context) => context.isRequired)
        .map((context) =>
          context.__typename === "CheckRun"
            ? {
                name: context.name,
                state:
                  context.conclusion ??
                  context.status,
                isRequired: context.isRequired,
              }
            : {
                name: context.context,
                state: context.state,
                isRequired: context.isRequired,
              },
        ),
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
      comments: await this.#listReviewThreadComments(response.node.id),
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

  async mergePullRequest(input: {
    pullRequest: PullRequestRef;
    method: MergeMethod;
    matchHeadCommit?: string | null;
  }): Promise<GitHubPullRequestMergeResult> {
    const args = [
      "pr",
      "merge",
      String(input.pullRequest.number),
      "--repo",
      formatRepo(input.pullRequest),
      input.method === "merge"
        ? "--merge"
        : input.method === "rebase"
          ? "--rebase"
          : "--squash",
    ];

    if (
      input.matchHeadCommit !== undefined &&
      input.matchHeadCommit !== null &&
      input.matchHeadCommit.trim().length > 0
    ) {
      args.push("--match-head-commit", input.matchHeadCommit.trim());
    }

    await this.#runText(args);
    const readiness = await this.readPullRequestMergeReadiness(input.pullRequest);

    return {
      method: input.method,
      pullRequest: readiness.pullRequest,
    };
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

  async #listPullRequestFiles(
    pullRequest: PullRequestRef,
  ): Promise<GitHubPullRequestReadResult["files"]> {
    const files: GitHubPullRequestReadResult["files"] = [];

    for await (const page of this.#paginateRest<Array<{
      filename: string;
      additions: number;
      deletions: number;
      status: string;
    }>>([
      `repos/${formatRepo(pullRequest)}/pulls/${pullRequest.number}/files`,
    ])) {
      files.push(
        ...page.map((file) => ({
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.status.toUpperCase(),
        })),
      );
    }

    return files;
  }

  async #listPullRequestReviews(
    pullRequest: PullRequestRef,
  ): Promise<GitHubPullRequestReadResult["reviews"]> {
    const reviews: GitHubPullRequestReadResult["reviews"] = [];

    for await (const page of this.#paginateRest<Array<{
      id: number;
      node_id: string;
      state: string;
      body: string | null;
      html_url: string | null;
      submitted_at: string | null;
      user: { login: string } | null;
    }>>([
      `repos/${formatRepo(pullRequest)}/pulls/${pullRequest.number}/reviews`,
    ])) {
      reviews.push(
        ...page.map((review) => ({
          id: review.node_id,
          state: review.state,
          body: review.body,
          url: review.html_url,
          submittedAt: review.submitted_at,
          authorLogin: review.user?.login ?? null,
        })),
      );
    }

    return reviews;
  }

  async #listPullRequestThreads(
    pullRequest: PullRequestRef,
  ): Promise<GitHubPullRequestThread[]> {
    const threads: GitHubPullRequestThread[] = [];
    let cursor: string | null = null;

    do {
      const response: GitHubPullRequestThreadsQuery = await this.#runGraphql<GitHubPullRequestThreadsQuery>(
        `
          query PullRequestThreads(
            $owner: String!
            $repo: String!
            $number: Int!
            $cursor: String
          ) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $number) {
                reviewThreads(first: 100, after: $cursor) {
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
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
            }
          }
        `,
        {
          owner: pullRequest.owner,
          repo: pullRequest.repo,
          number: pullRequest.number,
          ...(cursor === null ? {} : { cursor }),
        },
      );

      const reviewThreads: GitHubPullRequestThreadsPage | undefined =
        response.repository?.pullRequest?.reviewThreads;
      if (reviewThreads === undefined || reviewThreads === null) {
        break;
      }

      for (const thread of reviewThreads.nodes) {
        threads.push({
          id: thread.id,
          isResolved: thread.isResolved,
          isOutdated: thread.isOutdated,
          path: thread.path,
          line: thread.line,
          originalLine: thread.originalLine,
          startLine: thread.startLine,
          originalStartLine: thread.originalStartLine,
          diffSide: thread.diffSide,
          comments: await this.#listReviewThreadComments(thread.id),
        });
      }

      cursor =
        reviewThreads.pageInfo.hasNextPage === true
          ? reviewThreads.pageInfo.endCursor
          : null;
    } while (cursor !== null);

    return threads;
  }

  async #listReviewThreadComments(
    threadId: string,
  ): Promise<GitHubPullRequestThreadComment[]> {
    const comments: GitHubPullRequestThreadComment[] = [];
    let cursor: string | null = null;

    do {
      const response: GitHubReviewThreadCommentsQuery =
        await this.#runGraphql<GitHubReviewThreadCommentsQuery>(
        `
          query ReviewThreadComments($threadId: ID!, $cursor: String) {
            node(id: $threadId) {
              ... on PullRequestReviewThread {
                comments(first: 100, after: $cursor) {
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
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
            }
          }
        `,
        {
          threadId,
          ...(cursor === null ? {} : { cursor }),
        },
      );

      const page: GitHubReviewThreadCommentsPage | undefined =
        response.node?.comments;
      if (page === undefined || page === null) {
        break;
      }

      comments.push(
        ...page.nodes.map((comment: GitHubReviewThreadCommentsPage["nodes"][number]) => ({
          id: comment.id,
          databaseId: comment.databaseId,
          url: comment.url,
          body: comment.body,
          createdAt: comment.createdAt,
          authorLogin: comment.author?.login ?? null,
        })),
      );

      cursor =
        page.pageInfo.hasNextPage === true ? page.pageInfo.endCursor : null;
    } while (cursor !== null);

    return comments;
  }

  async *#paginateRest<T>(
    baseArgs: string[],
  ): AsyncGenerator<T, void, void> {
    let page = 1;

    while (true) {
      const url = new URL(baseArgs[0] ?? "", "https://github.local");
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));

      const response = await this.#runJson<T>(["api", url.pathname + url.search]);
      yield response;

      if (Array.isArray(response) === false || response.length < 100) {
        return;
      }

      page += 1;
    }
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
