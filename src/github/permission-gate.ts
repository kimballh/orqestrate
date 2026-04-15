import type { RuntimeApiRun } from "../runtime/api/types.js";
import { hasGrantedCapability } from "../runtime/capability-grants.js";

import {
  parsePullRequestUrl,
  pullRequestRefsEqual,
  type PullRequestRef,
} from "./scope.js";

export class GitHubPermissionError extends Error {
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
    this.name = "GitHubPermissionError";
    this.code = input.code;
    this.details = input.details ?? null;
  }
}

export function requireGrantedCapability(
  run: RuntimeApiRun,
  capability: string,
): void {
  if (hasGrantedCapability(run, capability)) {
    return;
  }

  throw new GitHubPermissionError(
    `Run '${run.runId}' is not authorized for '${capability}'.`,
    {
      code: "missing_capability",
      details: {
        runId: run.runId,
        capability,
      },
    },
  );
}

export function requireRepoWriteScope(run: RuntimeApiRun): void {
  if (run.workspace.writeScope === "repo") {
    return;
  }

  throw new GitHubPermissionError(
    `Run '${run.runId}' is missing repo write scope for GitHub write operations.`,
    {
      code: "missing_write_scope",
      details: {
        runId: run.runId,
        writeScope: run.workspace.writeScope ?? null,
      },
    },
  );
}

export function requireLinkedPullRequest(run: RuntimeApiRun): PullRequestRef {
  const pullRequestUrl = run.workspace.pullRequestUrl?.trim();
  if (pullRequestUrl === undefined || pullRequestUrl.length === 0) {
    throw new GitHubPermissionError(
      `Run '${run.runId}' is missing a linked pull request URL.`,
      {
        code: "missing_pull_request_context",
        details: {
          runId: run.runId,
        },
      },
    );
  }

  return parsePullRequestUrl(pullRequestUrl);
}

export function requireAssignedBranch(run: RuntimeApiRun): string {
  const assignedBranch = run.workspace.assignedBranch?.trim();
  if (assignedBranch === undefined || assignedBranch.length === 0) {
    throw new GitHubPermissionError(
      `Run '${run.runId}' is missing an assigned branch.`,
      {
        code: "missing_assigned_branch",
        details: {
          runId: run.runId,
        },
      },
    );
  }

  return assignedBranch;
}

export function assertPullRequestMatchesLinkedScope(
  linkedPullRequest: PullRequestRef,
  candidatePullRequest: PullRequestRef,
): void {
  if (pullRequestRefsEqual(linkedPullRequest, candidatePullRequest)) {
    return;
  }

  throw new GitHubPermissionError(
    `GitHub target '${candidatePullRequest.url}' is outside the linked pull request scope '${linkedPullRequest.url}'.`,
    {
      code: "pull_request_scope_mismatch",
      details: {
        linkedPullRequestUrl: linkedPullRequest.url,
        candidatePullRequestUrl: candidatePullRequest.url,
      },
    },
  );
}
