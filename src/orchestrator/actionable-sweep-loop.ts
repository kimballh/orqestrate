import type { PlanningBackend } from "../core/planning-backend.js";

import { createLinearIssueWakeup } from "./linear-issue-wakeup.js";
import { WakeupRepository } from "./wakeup-repository.js";

export type ActionableSweepResult = {
  candidateCount: number;
  insertedCount: number;
  coalescedCount: number;
  issueIds: string[];
};

export type ActionableSweepLoopDependencies = {
  planning: PlanningBackend;
  repository: WakeupRepository;
  intervalMs?: number;
  limit?: number;
  now?: () => Date;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
};

export class ActionableSweepLoop {
  private readonly intervalMs: number;
  private readonly limit: number;
  private readonly now: () => Date;
  private readonly setIntervalFn: typeof globalThis.setInterval;
  private readonly clearIntervalFn: typeof globalThis.clearInterval;
  private timer: ReturnType<typeof globalThis.setInterval> | null = null;
  private inFlightRun: Promise<ActionableSweepResult> | null = null;

  constructor(private readonly dependencies: ActionableSweepLoopDependencies) {
    this.intervalMs = dependencies.intervalMs ?? 60_000;
    this.limit = dependencies.limit ?? 10;
    this.now = dependencies.now ?? (() => new Date());
    this.setIntervalFn = dependencies.setInterval ?? globalThis.setInterval;
    this.clearIntervalFn =
      dependencies.clearInterval ?? globalThis.clearInterval;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }

    this.timer = this.setIntervalFn(() => {
      void this.runOnce();
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer === null) {
      await this.inFlightRun;
      return;
    }

    this.clearIntervalFn(this.timer);
    this.timer = null;
    await this.inFlightRun;
  }

  async runOnce(): Promise<ActionableSweepResult> {
    if (this.inFlightRun !== null) {
      return this.inFlightRun;
    }

    const runPromise = this.performRunOnce().finally(() => {
      if (this.inFlightRun === runPromise) {
        this.inFlightRun = null;
      }
    });
    this.inFlightRun = runPromise;

    return runPromise;
  }

  private async performRunOnce(): Promise<ActionableSweepResult> {
    if (!Number.isInteger(this.limit) || this.limit < 0) {
      throw new Error("Actionable sweep limit must be a non-negative integer.");
    }

    if (this.limit === 0) {
      return {
        candidateCount: 0,
        insertedCount: 0,
        coalescedCount: 0,
        issueIds: [],
      };
    }

    const candidates = await this.dependencies.planning.listActionableWorkItems({
      limit: this.limit,
    });
    const discoveredAt = this.now().toISOString();
    let insertedCount = 0;
    let coalescedCount = 0;

    for (const candidate of candidates) {
      const result = this.dependencies.repository.enqueue(
        createLinearIssueWakeup({
          deliveryId: `sweep:${discoveredAt}:${candidate.id}`,
          resourceId: candidate.id,
          issueId: candidate.id,
          action: "sweep",
          receivedAt: discoveredAt,
          payloadJson: JSON.stringify({
            source: "actionable_sweep",
            workItemId: candidate.id,
          }),
        }),
      );

      if (result.kind === "inserted") {
        insertedCount += 1;
      } else {
        coalescedCount += 1;
      }
    }

    return {
      candidateCount: candidates.length,
      insertedCount,
      coalescedCount,
      issueIds: candidates.map((candidate) => candidate.id),
    };
  }
}
