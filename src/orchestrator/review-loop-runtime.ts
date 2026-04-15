import type { RunWorkspaceRecord } from "../domain-model.js";

import type { RuntimeObserver } from "./runtime-observer.js";
import type { PrepareClaimedRunWorkspaceInput } from "./types.js";

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

function hasReviewLoopWorkspace(workspace: RunWorkspaceRecord): boolean {
  return [
    workspace.assignedBranch,
    workspace.pullRequestUrl,
    workspace.writeScope,
  ].some((value) => typeof value === "string" && value.trim().length > 0);
}
