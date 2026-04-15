import type { MergePolicyConfig } from "../config/types.js";
import type { WorkItemRecord } from "../domain-model.js";
import { GitHubCliClient } from "../github/client.js";
import { classifyPullRequestReviewLoop } from "../github/review-loop.js";
import { parsePullRequestUrl } from "../github/scope.js";

import { Reconciler } from "./reconciler.js";
import {
  findLatestReviewLoopRuntimeRun,
  hydrateReviewLoopWorkspace,
} from "./review-loop-runtime.js";
import type {
  LeaseObservation,
  ReconciliationResult,
} from "./reconciliation-types.js";
import type { RuntimeObserver } from "./runtime-observer.js";
import type { ContextBackend } from "../core/context-backend.js";
import type { PlanningBackend } from "../core/planning-backend.js";

const DRIFT_STATUSES = [
  "admitted",
  "launching",
  "bootstrapping",
  "running",
  "waiting_human",
  "stopping",
  "completed",
  "failed",
  "canceled",
  "stale",
] as const;

export type ReconciliationLoopDependencies = {
  planning: PlanningBackend;
  context: ContextBackend;
  runtimeObserver: RuntimeObserver;
  owner: string;
  leaseDurationMs: number;
  mergePolicy?: MergePolicyConfig;
  fastIntervalMs?: number;
  driftIntervalMs?: number;
  now?: () => Date;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  listTrackedWorkItems?: () => Promise<WorkItemRecord[]>;
  createGitHubClient?: (
    cwd: string,
  ) => Pick<
    GitHubCliClient,
    "readPullRequest" | "readPullRequestMergeReadiness" | "findOpenPullRequestForBranch"
  >;
  getOriginRemoteUrl?: (cwd: string) => Promise<string>;
};

export class ReconciliationLoop {
  private readonly planning: PlanningBackend;
  private readonly runtimeObserver: RuntimeObserver;
  private readonly reconciler: Reconciler;
  private readonly listTrackedWorkItems: (() => Promise<WorkItemRecord[]>) | null;
  private readonly now: () => Date;
  private readonly setIntervalFn: typeof globalThis.setInterval;
  private readonly clearIntervalFn: typeof globalThis.clearInterval;
  private readonly fastIntervalMs: number;
  private readonly driftIntervalMs: number;
  private readonly createGitHubClient: (
    cwd: string,
  ) => Pick<
    GitHubCliClient,
    "readPullRequest" | "readPullRequestMergeReadiness" | "findOpenPullRequestForBranch"
  >;
  private readonly getOriginRemoteUrl: ((cwd: string) => Promise<string>) | undefined;
  private readonly trackedWorkItemIds = new Set<string>();
  private readonly observations = new Map<string, LeaseObservation>();
  private fastTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private driftTimer: ReturnType<typeof globalThis.setInterval> | null = null;

  constructor(dependencies: ReconciliationLoopDependencies) {
    this.planning = dependencies.planning;
    this.runtimeObserver = dependencies.runtimeObserver;
    this.reconciler = new Reconciler({
      planning: dependencies.planning,
      context: dependencies.context,
      runtimeObserver: dependencies.runtimeObserver,
      owner: dependencies.owner,
      leaseDurationMs: dependencies.leaseDurationMs,
      mergePolicy: dependencies.mergePolicy,
      createGitHubClient: dependencies.createGitHubClient,
      now: dependencies.now,
    });
    this.listTrackedWorkItems = dependencies.listTrackedWorkItems ?? null;
    this.now = dependencies.now ?? (() => new Date());
    this.setIntervalFn = dependencies.setInterval ?? globalThis.setInterval;
    this.clearIntervalFn = dependencies.clearInterval ?? globalThis.clearInterval;
    this.fastIntervalMs = dependencies.fastIntervalMs ?? 30_000;
    this.driftIntervalMs = dependencies.driftIntervalMs ?? 300_000;
    this.createGitHubClient =
      dependencies.createGitHubClient ??
      ((cwd) =>
        new GitHubCliClient({
          cwd,
        }));
    this.getOriginRemoteUrl = dependencies.getOriginRemoteUrl;
  }

  get isRunning(): boolean {
    return this.fastTimer !== null || this.driftTimer !== null;
  }

  trackWorkItem(id: string): void {
    this.trackedWorkItemIds.add(id);
  }

  untrackWorkItem(id: string): void {
    this.trackedWorkItemIds.delete(id);
  }

  start(): void {
    if (this.fastTimer === null) {
      this.fastTimer = this.setIntervalFn(() => {
        void this.runFastTick();
      }, this.fastIntervalMs);
    }

    if (this.driftTimer === null) {
      this.driftTimer = this.setIntervalFn(() => {
        void this.runDriftTick();
      }, this.driftIntervalMs);
    }
  }

  stop(): void {
    if (this.fastTimer !== null) {
      this.clearIntervalFn(this.fastTimer);
      this.fastTimer = null;
    }

    if (this.driftTimer !== null) {
      this.clearIntervalFn(this.driftTimer);
      this.driftTimer = null;
    }
  }

  async runFastTick(): Promise<ReconciliationResult[]> {
    const runtimeHealthy = (await this.runtimeObserver.getHealth()).ok;
    const workItems = await this.collectTrackedWorkItems();
    const results: ReconciliationResult[] = [];

    for (const workItem of workItems) {
      const observation =
        (workItem.orchestration.runId ?? null) === null
          ? null
          : this.observations.get(workItem.orchestration.runId ?? "") ?? null;
      const result = await this.reconciler.reconcileLeasedWorkItem({
        workItem,
        runtimeHealthy,
        observation,
      });
      results.push(result);
      this.updateObservation(result);
      this.updateTrackedWorkItem(result.workItem);
    }

    await this.inspectQueuedReviewLoopWorkItems(workItems);

    return results;
  }

  async runDriftTick(): Promise<ReconciliationResult[]> {
    const runtimeHealthy = (await this.runtimeObserver.getHealth()).ok;
    const runs = await this.listRuntimeRuns();
    const results: ReconciliationResult[] = [];

    for (const runtimeRun of runs) {
      const result = await this.reconciler.reconcileRuntimeRun({
        runtimeRun,
        runtimeHealthy,
      });
      results.push(result);
      this.updateObservation(result);
    }

    return results;
  }

  private async collectTrackedWorkItems(): Promise<WorkItemRecord[]> {
    const itemsById = new Map<string, WorkItemRecord>();

    if (this.listTrackedWorkItems !== null) {
      const listedItems = await this.listTrackedWorkItems();

      for (const workItem of listedItems) {
        itemsById.set(workItem.id, workItem);
      }
    }

    for (const id of this.trackedWorkItemIds) {
      if (itemsById.has(id)) {
        continue;
      }

      const workItem = await this.planning.getWorkItem(id);

      if (workItem !== null) {
        itemsById.set(id, workItem);
      }
    }

    return [...itemsById.values()];
  }

  private async inspectQueuedReviewLoopWorkItems(
    workItems: readonly WorkItemRecord[],
  ): Promise<void> {
    for (const workItem of workItems) {
      if (
        (workItem.status !== "implement" && workItem.status !== "review") ||
        workItem.orchestration.state !== "queued"
      ) {
        continue;
      }

      const runtimeRun = await findLatestReviewLoopRuntimeRun(
        this.runtimeObserver,
        workItem.id,
      );

      if (runtimeRun === null) {
        continue;
      }

      const hydratedWorkspace = await hydrateReviewLoopWorkspace({
        repoRoot: runtimeRun.repoRoot,
        workspace: {
          mode: runtimeRun.workspace.mode,
          baseRef: runtimeRun.workspace.baseRef ?? null,
          assignedBranch: runtimeRun.workspace.assignedBranch ?? null,
          pullRequestUrl: runtimeRun.workspace.pullRequestUrl ?? null,
          pullRequestMode: runtimeRun.workspace.pullRequestMode ?? null,
          writeScope: runtimeRun.workspace.writeScope ?? null,
        },
        createGitHubClient: this.createGitHubClient,
        getOriginRemoteUrl: this.getOriginRemoteUrl,
      });
      const pullRequestUrl = hydratedWorkspace?.pullRequestUrl ?? null;

      if (pullRequestUrl === null) {
        continue;
      }

      const client = this.createGitHubClient(runtimeRun.repoRoot);
      const snapshot = classifyPullRequestReviewLoop(
        await client.readPullRequest(parsePullRequestUrl(pullRequestUrl)),
      );

      if (snapshot.ambiguousThreadIds.length > 0) {
        await this.planning.transitionWorkItem({
          id: workItem.id,
          nextStatus: "blocked",
          nextPhase: workItem.phase,
          state: "waiting_human",
          blockedReason:
            "GitHub review loop is blocked because unresolved pull request threads could not be classified safely.",
        });
        await this.planning.appendComment({
          id: workItem.id,
          body: [
            "GitHub review-loop routing is blocked.",
            "",
            "Unresolved pull request threads could not be classified safely, so the issue was moved to `Blocked` for human triage.",
          ].join("\n"),
        });
        continue;
      }

      if (
        workItem.status === "review" &&
        snapshot.implementerActionThreadIds.length > 0
      ) {
        await this.planning.transitionWorkItem({
          id: workItem.id,
          nextStatus: "implement",
          nextPhase: "implement",
          state: "queued",
        });
        await this.planning.appendComment({
          id: workItem.id,
          body: [
            "GitHub review-loop routing requeued implementation.",
            "",
            "The linked pull request has unresolved review feedback that now requires implementation-side action.",
          ].join("\n"),
        });
        continue;
      }

      if (
        workItem.status === "implement" &&
        snapshot.implementerActionThreadIds.length === 0 &&
        snapshot.reviewerActionThreadIds.length > 0
      ) {
        await this.planning.transitionWorkItem({
          id: workItem.id,
          nextStatus: "review",
          nextPhase: "review",
          state: "queued",
        });
        await this.planning.appendComment({
          id: workItem.id,
          body: [
            "GitHub review-loop routing requeued review.",
            "",
            "The linked pull request is now waiting on reviewer-side follow-up rather than more implementation work.",
          ].join("\n"),
        });
      }
    }
  }

  private async listRuntimeRuns() {
    const runs = [];

    for (const status of DRIFT_STATUSES) {
      let cursor: string | undefined;

      do {
        const page = await this.runtimeObserver.listRuns({
          status,
          limit: 100,
          cursor,
        });
        runs.push(...page.runs);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
    }

    return runs;
  }

  private updateObservation(result: ReconciliationResult): void {
    const observation = result.observation ?? null;

    if (observation !== null) {
      this.observations.set(observation.runId, observation);
      return;
    }

    const runId =
      result.classification.runtimeRun?.runId ??
      result.workItem?.orchestration.runId ??
      null;

    if (runId !== null && result.handledOutcome) {
      this.observations.delete(runId);
    }
  }

  private updateTrackedWorkItem(workItem: WorkItemRecord | null): void {
    if (workItem === null) {
      return;
    }

    if (
      workItem.orchestration.state !== "claimed" &&
      workItem.orchestration.state !== "running"
    ) {
      this.trackedWorkItemIds.delete(workItem.id);
    }
  }
}
