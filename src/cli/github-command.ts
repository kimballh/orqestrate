import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

import type { RuntimeApiRun } from "../runtime/api/types.js";
import {
  GitHubCliClient,
  type GitHubReviewCommentInput,
  GitHubClientError,
} from "../github/client.js";
import type { GitHubCliClient as GitHubCliClientType } from "../github/client.js";
import { appendPullRequestReviewLoopMarker } from "../github/review-loop.js";
import {
  assertPullRequestMatchesLinkedScope,
  requireAssignedBranch,
  requireGrantedCapability,
  requireLinkedPullRequest,
  requireRepoWriteScope,
  GitHubPermissionError,
} from "../github/permission-gate.js";
import {
  GitHubRuntimeContextError,
  loadGitHubRuntimeRun,
} from "../github/runtime-context.js";
import { normalizeBranchName, parseGitRemoteUrl } from "../github/scope.js";

const execFileAsync = promisify(execFile);

type WriteFn = (message: string) => void;

type GitHubCommandDependencies = {
  cwd?: () => string;
  env?: NodeJS.ProcessEnv;
  stdout?: WriteFn;
  stderr?: WriteFn;
  loadRun?: (env: NodeJS.ProcessEnv) => Promise<RuntimeApiRun>;
  createClient?: (cwd: string, env: NodeJS.ProcessEnv) => GitHubCliClientType;
  getOriginRemoteUrl?: (cwd: string) => Promise<string>;
};

type PrUpsertOptions = {
  title: string;
  body: string;
  baseBranch?: string;
};

type ThreadReplyOptions = {
  threadId: string;
  body: string;
};

type ThreadResolveOptions = {
  threadId: string;
};

type ReviewWriteOptions = {
  body: string;
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  comments: GitHubReviewCommentInput[];
};

type GitHubCommandErrorShape = {
  code: string;
  message: string;
  details?: Record<string, unknown> | null;
};

export async function runGithubCommand(
  args: string[],
  dependencies: GitHubCommandDependencies = {},
): Promise<number> {
  if (args.length === 0 || isHelpFlag(args[0])) {
    write(dependencies.stdout, renderGitHubHelp());
    return 0;
  }

  const env = dependencies.env ?? process.env;
  const cwd = (dependencies.cwd ?? process.cwd)();
  const loadRun =
    dependencies.loadRun ??
    ((runtimeEnv) => loadGitHubRuntimeRun(runtimeEnv));
  const createClient =
    dependencies.createClient ??
    ((commandCwd, runtimeEnv) =>
      new GitHubCliClient({
        cwd: commandCwd,
        env: runtimeEnv,
      }));

  try {
    const subcommand = args[0];
    const helpText = renderGitHubSubcommandHelp(subcommand, args.slice(1));
    if (helpText !== null) {
      write(dependencies.stdout, helpText);
      return 0;
    }

    const run = await loadRun(env);
    const client = createClient(cwd, env);

    switch (subcommand) {
      case "pr-read":
        assertNoExtraArgs(args.slice(1), "pr-read");
        return await handlePrRead(run, client, dependencies.stdout);
      case "pr-upsert":
        return await handlePrUpsert(
          run,
          client,
          parsePrUpsertOptions(args.slice(1)),
          cwd,
          dependencies,
        );
      case "review-thread-reply":
        return await handleReviewThreadReply(
          run,
          client,
          parseThreadReplyOptions(args.slice(1)),
          dependencies.stdout,
        );
      case "review-thread-resolve":
        return await handleReviewThreadResolve(
          run,
          client,
          parseThreadResolveOptions(args.slice(1)),
          dependencies.stdout,
        );
      case "review-write":
        return await handleReviewWrite(
          run,
          client,
          parseReviewWriteOptions(args.slice(1)),
          dependencies.stdout,
        );
      default:
        throw createCommandError(
          "unknown_command",
          `Unknown GitHub command '${subcommand}'.`,
        );
    }
  } catch (error) {
    write(
      dependencies.stderr,
      JSON.stringify(
        {
          error: toCommandErrorShape(error),
        },
        null,
        2,
      ),
    );
    return 1;
  }
}

export function renderGitHubHelp(): string {
  return [
    "GitHub commands:",
    `  ${renderPrReadHelp()}`,
    `  ${renderPrUpsertHelp()}`,
    `  ${renderReviewThreadReplyHelp()}`,
    `  ${renderReviewThreadResolveHelp()}`,
    `  ${renderReviewWriteHelp()}`,
  ].join("\n");
}

async function handlePrRead(
  run: RuntimeApiRun,
  client: GitHubCliClientType,
  stdout: WriteFn | undefined,
): Promise<number> {
  requireGrantedCapability(run, "github.read_pr");
  const pullRequest = requireLinkedPullRequest(run);
  const result = await client.readPullRequest(pullRequest);

  write(
    stdout,
    JSON.stringify(
      {
        ...result,
        unresolvedThreadCount: result.threads.filter(
          (thread) => thread.isResolved === false,
        ).length,
      },
      null,
      2,
    ),
  );

  return 0;
}

async function handlePrUpsert(
  run: RuntimeApiRun,
  client: GitHubCliClientType,
  options: PrUpsertOptions,
  cwd: string,
  dependencies: GitHubCommandDependencies,
): Promise<number> {
  requireGrantedCapability(run, "github.create_pr");
  requireRepoWriteScope(run);
  const assignedBranch = normalizeBranchName(requireAssignedBranch(run));
  const originRemoteUrl = await (
    dependencies.getOriginRemoteUrl ?? defaultGetOriginRemoteUrl
  )(cwd);

  let result;
  if (
    run.workspace.pullRequestUrl !== null &&
    run.workspace.pullRequestUrl !== undefined
  ) {
    const pullRequest = requireLinkedPullRequest(run);
    const current = await client.getPullRequestSummary(pullRequest);
    if (normalizeBranchName(current.headRefName) !== assignedBranch) {
      throw createCommandError(
        "assigned_branch_scope_mismatch",
        `Linked pull request '${current.url}' points at '${current.headRefName}', not the assigned branch '${assignedBranch}'.`,
        {
          pullRequestUrl: current.url,
          assignedBranch,
          headRefName: current.headRefName,
        },
      );
    }

    result = await client.updatePullRequest({
      pullRequest,
      title: options.title,
      body: options.body,
    });
  } else {
    const repo = parseGitRemoteUrl(originRemoteUrl);
    const existing = await client.findOpenPullRequestForBranch({
      repo,
      headBranch: assignedBranch,
    });

    result =
      existing === null
        ? await client.createPullRequest({
            repo,
            headBranch: assignedBranch,
            title: options.title,
            body: options.body,
            baseBranch: options.baseBranch,
          })
        : await client.updatePullRequest({
            pullRequest: {
              owner: repo.owner,
              repo: repo.repo,
              number: existing.number,
              url: existing.url,
            },
            title: options.title,
            body: options.body,
          });
  }

  write(dependencies.stdout, JSON.stringify(result, null, 2));
  return 0;
}

async function handleReviewThreadReply(
  run: RuntimeApiRun,
  client: GitHubCliClientType,
  options: ThreadReplyOptions,
  stdout: WriteFn | undefined,
): Promise<number> {
  requireGrantedCapability(run, "github.reply_review_thread");
  requireRepoWriteScope(run);
  const linkedPullRequest = requireLinkedPullRequest(run);
  const thread = await client.getReviewThread(options.threadId);
  assertPullRequestMatchesLinkedScope(linkedPullRequest, thread.pullRequest);

  const rootComment = thread.comments[0];
  if (
    rootComment?.databaseId === null ||
    rootComment?.databaseId === undefined
  ) {
    throw createCommandError(
      "missing_thread_comment_id",
      `Review thread '${options.threadId}' does not expose a replyable root comment ID.`,
      {
        threadId: options.threadId,
      },
    );
  }

  const reply = await client.replyToReviewComment({
    repo: thread.pullRequest,
    pullRequestNumber: thread.pullRequest.number,
    commentId: rootComment.databaseId,
    body: appendPullRequestReviewLoopMarker(options.body, {
      runId: run.runId,
      phase: "implement",
      role: "implement",
      threadId: options.threadId,
    }),
  });

  write(
    stdout,
    JSON.stringify(
      {
        threadId: thread.id,
        pullRequestUrl: thread.pullRequest.url,
        reply,
      },
      null,
      2,
    ),
  );

  return 0;
}

async function handleReviewThreadResolve(
  run: RuntimeApiRun,
  client: GitHubCliClientType,
  options: ThreadResolveOptions,
  stdout: WriteFn | undefined,
): Promise<number> {
  requireGrantedCapability(run, "github.resolve_review_thread");
  requireRepoWriteScope(run);
  const linkedPullRequest = requireLinkedPullRequest(run);
  const thread = await client.getReviewThread(options.threadId);
  assertPullRequestMatchesLinkedScope(linkedPullRequest, thread.pullRequest);
  const resolved = await client.resolveReviewThread(options.threadId);

  write(
    stdout,
    JSON.stringify(
      {
        threadId: thread.id,
        pullRequestUrl: thread.pullRequest.url,
        resolution: resolved,
      },
      null,
      2,
    ),
  );

  return 0;
}

async function handleReviewWrite(
  run: RuntimeApiRun,
  client: GitHubCliClientType,
  options: ReviewWriteOptions,
  stdout: WriteFn | undefined,
): Promise<number> {
  requireGrantedCapability(run, "github.write_review");
  requireRepoWriteScope(run);
  const linkedPullRequest = requireLinkedPullRequest(run);
  const pullRequest = await client.getPullRequestSummary(linkedPullRequest);
  const viewerLogin = await client.getViewerLogin();
  const degradedToCommentOnly =
    viewerLogin !== null &&
    pullRequest.authorLogin !== null &&
    viewerLogin === pullRequest.authorLogin &&
    options.event !== "COMMENT";
  const event = degradedToCommentOnly ? "COMMENT" : options.event;
  const review = await client.submitReview({
    repo: linkedPullRequest,
    pullRequestNumber: linkedPullRequest.number,
    body: appendPullRequestReviewLoopMarker(options.body, {
      runId: run.runId,
      phase: "review",
      role: "review",
    }),
    event,
    comments: options.comments.map((comment) => ({
      ...comment,
      body: appendPullRequestReviewLoopMarker(comment.body, {
        runId: run.runId,
        phase: "review",
        role: "review",
      }),
    })),
  });

  write(
    stdout,
    JSON.stringify(
      {
        pullRequestUrl: pullRequest.url,
        viewerLogin,
        eventRequested: options.event,
        eventApplied: event,
        degradedToCommentOnly,
        review,
        inlineCommentCount: options.comments.length,
      },
      null,
      2,
    ),
  );

  return 0;
}

function parsePrUpsertOptions(args: string[]): PrUpsertOptions {
  const options: Partial<PrUpsertOptions> = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--title":
        options.title = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--body":
        options.body = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--base":
        options.baseBranch = readOptionValue(args, index, argument);
        index += 1;
        break;
      default:
        throw createCommandError(
          "invalid_argument",
          `Unknown pr-upsert option '${argument}'.`,
        );
    }
  }

  if ((options.title ?? "").trim().length === 0) {
    throw createCommandError(
      "missing_argument",
      "pr-upsert requires --title <title>.",
    );
  }

  if ((options.body ?? "").trim().length === 0) {
    throw createCommandError(
      "missing_argument",
      "pr-upsert requires --body <body>.",
    );
  }

  return options as PrUpsertOptions;
}

function parseThreadReplyOptions(args: string[]): ThreadReplyOptions {
  const options: Partial<ThreadReplyOptions> = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--thread-id":
        options.threadId = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--body":
        options.body = readOptionValue(args, index, argument);
        index += 1;
        break;
      default:
        throw createCommandError(
          "invalid_argument",
          `Unknown review-thread-reply option '${argument}'.`,
        );
    }
  }

  if ((options.threadId ?? "").trim().length === 0) {
    throw createCommandError(
      "missing_argument",
      "review-thread-reply requires --thread-id <id>.",
    );
  }

  if ((options.body ?? "").trim().length === 0) {
    throw createCommandError(
      "missing_argument",
      "review-thread-reply requires --body <body>.",
    );
  }

  return options as ThreadReplyOptions;
}

function parseThreadResolveOptions(args: string[]): ThreadResolveOptions {
  if (args.length !== 2 || args[0] !== "--thread-id") {
    throw createCommandError(
      "missing_argument",
      "review-thread-resolve requires --thread-id <id>.",
    );
  }

  return {
    threadId: args[1] ?? "",
  };
}

function parseReviewWriteOptions(args: string[]): ReviewWriteOptions {
  const options: ReviewWriteOptions = {
    body: "",
    event: "COMMENT",
    comments: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    switch (argument) {
      case "--body":
        options.body = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--event":
        options.event = parseReviewEvent(readOptionValue(args, index, argument));
        index += 1;
        break;
      case "--comment-json":
        options.comments.push(
          parseReviewCommentJson(readOptionValue(args, index, argument)),
        );
        index += 1;
        break;
      default:
        throw createCommandError(
          "invalid_argument",
          `Unknown review-write option '${argument}'.`,
        );
    }
  }

  if (options.body.trim().length === 0) {
    throw createCommandError(
      "missing_argument",
      "review-write requires --body <body>.",
    );
  }

  return options;
}

function parseReviewEvent(
  value: string,
): "COMMENT" | "APPROVE" | "REQUEST_CHANGES" {
  switch (value.trim().toLowerCase()) {
    case "comment":
      return "COMMENT";
    case "approve":
      return "APPROVE";
    case "request-changes":
    case "request_changes":
      return "REQUEST_CHANGES";
    default:
      throw createCommandError(
        "invalid_argument",
        `Unsupported review event '${value}'. Expected comment, approve, or request-changes.`,
      );
  }
}

function parseReviewCommentJson(value: string): GitHubReviewCommentInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw createCommandError(
      "invalid_argument",
      "review-write --comment-json must be valid JSON.",
      {
        value,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw createCommandError(
      "invalid_argument",
      "review-write --comment-json must be an object.",
      {
        value,
      },
    );
  }

  const record = parsed as Record<string, unknown>;
  const pathValue = String(record.path ?? "").trim();
  const bodyValue = String(record.body ?? "").trim();
  const lineValue = Number(record.line);
  const sideValue =
    record.side === "LEFT" || record.side === "RIGHT"
      ? record.side
      : "RIGHT";

  if (pathValue.length === 0 || bodyValue.length === 0) {
    throw createCommandError(
      "invalid_argument",
      "review-write --comment-json requires non-empty path and body fields.",
      {
        value,
      },
    );
  }

  if (Number.isInteger(lineValue) === false || lineValue <= 0) {
    throw createCommandError(
      "invalid_argument",
      "review-write --comment-json requires a positive integer line field.",
      {
        value,
      },
    );
  }

  return {
    path: pathValue,
    line: lineValue,
    body: bodyValue,
    side: sideValue,
  };
}

function parseErrorShape(error: unknown): GitHubCommandErrorShape | null {
  if (error instanceof GitHubRuntimeContextError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof GitHubPermissionError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof GitHubClientError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    const details =
      "details" in error && typeof error.details === "object"
        ? (error.details as Record<string, unknown>)
        : null;

    return {
      code: error.code,
      message: error.message,
      details,
    };
  }

  return null;
}

function toCommandErrorShape(error: unknown): GitHubCommandErrorShape {
  return (
    parseErrorShape(error) ?? {
      code: "unexpected",
      message:
        error instanceof Error ? error.message : "GitHub command failed unexpectedly.",
      details: null,
    }
  );
}

function createCommandError(
  code: string,
  message: string,
  details?: Record<string, unknown> | null,
): Error & GitHubCommandErrorShape {
  const error = new Error(message) as Error & GitHubCommandErrorShape;
  error.name = "GitHubCommandError";
  error.code = code;
  error.details = details ?? null;
  return error;
}

function renderGitHubSubcommandHelp(
  subcommand: string,
  args: string[],
): string | null {
  if (!isSubcommandHelpRequest(subcommand, args)) {
    return null;
  }

  switch (subcommand) {
    case "pr-read":
      return renderPrReadHelp();
    case "pr-upsert":
      return renderPrUpsertHelp();
    case "review-thread-reply":
      return renderReviewThreadReplyHelp();
    case "review-thread-resolve":
      return renderReviewThreadResolveHelp();
    case "review-write":
      return renderReviewWriteHelp();
    default:
      return renderGitHubHelp();
  }
}

async function defaultGetOriginRemoteUrl(cwd: string): Promise<string> {
  const response = await execFileAsync("git", ["remote", "get-url", "origin"], {
    cwd,
    maxBuffer: 1024 * 1024,
  });

  return response.stdout.trim();
}

function assertNoExtraArgs(args: string[], commandName: string): void {
  if (args.length === 0) {
    return;
  }

  throw createCommandError(
    "invalid_argument",
    `${commandName} does not accept positional arguments.`,
    {
      args,
    },
  );
}

function isHelpFlag(argument: string): boolean {
  return argument === "--help" || argument === "-h";
}

function containsHelpFlag(args: string[]): boolean {
  return args.some((argument) => isHelpFlag(argument));
}

function isSubcommandHelpRequest(subcommand: string, args: string[]): boolean {
  switch (subcommand) {
    case "pr-read":
      return args.length === 1 && isHelpFlag(args[0] ?? "");
    case "pr-upsert":
      return hasStandaloneHelpFlag(args, new Set(["--title", "--body", "--base"]));
    case "review-thread-reply":
      return hasStandaloneHelpFlag(args, new Set(["--thread-id", "--body"]));
    case "review-thread-resolve":
      return args.length === 1 && isHelpFlag(args[0] ?? "");
    case "review-write":
      return hasStandaloneHelpFlag(
        args,
        new Set(["--body", "--event", "--comment-json"]),
      );
    default:
      return containsHelpFlag(args);
  }
}

function hasStandaloneHelpFlag(
  args: string[],
  optionsWithValues: ReadonlySet<string>,
): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (isHelpFlag(argument)) {
      return true;
    }

    if (optionsWithValues.has(argument)) {
      index += 1;
    }
  }

  return false;
}

function readOptionValue(
  args: string[],
  index: number,
  option: string,
): string {
  const value = args[index + 1];
  if (value === undefined) {
    throw createCommandError(
      "missing_argument",
      `${option} requires a value.`,
    );
  }

  return value;
}

function write(writeFn: WriteFn | undefined, message: string): void {
  (writeFn ?? console.log)(message);
}

function renderPrReadHelp(): string {
  return "github pr-read";
}

function renderPrUpsertHelp(): string {
  return "github pr-upsert --title <title> --body <body> [--base <branch>]";
}

function renderReviewThreadReplyHelp(): string {
  return "github review-thread-reply --thread-id <id> --body <body>";
}

function renderReviewThreadResolveHelp(): string {
  return "github review-thread-resolve --thread-id <id>";
}

function renderReviewWriteHelp(): string {
  return "github review-write --body <body> [--event comment|approve|request-changes] [--comment-json <json>]";
}
