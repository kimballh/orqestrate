import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { RunWorkspaceRecord } from "../domain-model.js";
import type { GitHubCliClient } from "../github/client.js";
import { normalizeBranchName, parseGitRemoteUrl } from "../github/scope.js";

import type { RuntimeObserver } from "./runtime-observer.js";
import type { PrepareClaimedRunWorkspaceInput } from "./types.js";

const execFileAsync = promisify(execFile);

export async function findLatestReviewLoopRuntimeRun(
  runtimeObserver: RuntimeObserver | undefined,
  workItemId: string,
) {
  if (runtimeObserver === undefined) {
    return null;
  }

  let cursor: string | undefined;

  do {
    const page = await runtimeObserver.listRuns({
      workItemId,
      limit: 20,
      cursor,
    });
    const matchingRun = page.runs.find((run) =>
      hasReviewLoopWorkspace(run.workspace),
    );

    if (matchingRun !== undefined) {
      return matchingRun;
    }

    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  return null;
}

export function mergeReviewLoopWorkspace(
  workspace: PrepareClaimedRunWorkspaceInput | undefined,
  recoveredWorkspace: RunWorkspaceRecord | null,
): PrepareClaimedRunWorkspaceInput | undefined {
  if (recoveredWorkspace === null) {
    return workspace;
  }

  return {
    mode: workspace?.mode ?? recoveredWorkspace.mode,
    baseRef: workspace?.baseRef ?? recoveredWorkspace.baseRef ?? null,
    assignedBranch:
      workspace?.assignedBranch ?? recoveredWorkspace.assignedBranch ?? null,
    pullRequestUrl:
      workspace?.pullRequestUrl ?? recoveredWorkspace.pullRequestUrl ?? null,
    pullRequestMode:
      workspace?.pullRequestMode ?? recoveredWorkspace.pullRequestMode ?? null,
    writeScope: workspace?.writeScope ?? recoveredWorkspace.writeScope ?? null,
    workingDirHint: workspace?.workingDirHint ?? null,
  };
}

export async function hydrateReviewLoopWorkspace(input: {
  repoRoot: string;
  workspace: PrepareClaimedRunWorkspaceInput | undefined;
  createGitHubClient: (
    cwd: string,
  ) => Pick<GitHubCliClient, "findOpenPullRequestForBranch">;
  getOriginRemoteUrl?: (cwd: string) => Promise<string>;
}): Promise<PrepareClaimedRunWorkspaceInput | undefined> {
  const workspace = input.workspace;

  if (
    workspace === undefined ||
    workspace.pullRequestUrl !== null && workspace.pullRequestUrl !== undefined ||
    workspace.assignedBranch === null ||
    workspace.assignedBranch === undefined
  ) {
    return workspace;
  }

  const originRemoteUrl = await (
    input.getOriginRemoteUrl ?? defaultGetOriginRemoteUrl
  )(input.repoRoot);
  const repo = parseGitRemoteUrl(originRemoteUrl);
  const client = input.createGitHubClient(input.repoRoot);
  const pullRequest = await client.findOpenPullRequestForBranch({
    repo,
    headBranch: normalizeBranchName(workspace.assignedBranch),
  });

  if (pullRequest === null) {
    return workspace;
  }

  return {
    ...workspace,
    pullRequestUrl: pullRequest.url,
  };
}

function hasReviewLoopWorkspace(workspace: RunWorkspaceRecord): boolean {
  return [
    workspace.assignedBranch,
    workspace.pullRequestUrl,
    workspace.writeScope,
  ].some((value) => typeof value === "string" && value.trim().length > 0);
}

async function defaultGetOriginRemoteUrl(cwd: string): Promise<string> {
  const response = await execFileAsync("git", ["remote", "get-url", "origin"], {
    cwd,
    maxBuffer: 1024 * 1024,
  });

  return response.stdout.trim();
}
