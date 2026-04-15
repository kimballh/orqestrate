import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { PlanningProviderConfig } from "../config/types.js";
import type {
  AppendCommentInput,
  ClaimWorkItemInput,
  ListActionableWorkItemsInput,
  MarkWorkItemRunningInput,
  RenewLeaseInput,
  TransitionWorkItemInput,
} from "../core/planning-backend.js";
import { PlanningBackend } from "../core/planning-backend.js";
import type { WorkItemRecord } from "../domain-model.js";
import { normalizeLinearWebhookEvent } from "../providers/planning/linear/webhook-normalizer.js";

import { ActionableSweepLoop } from "./actionable-sweep-loop.js";
import { openWakeupDatabase } from "./wakeup-database.js";
import { WakeupRepository } from "./wakeup-repository.js";

test("actionable sweep enqueues actionable issues through the wakeup queue", async (t) => {
  const fixture = createFixture(t);
  const database = openWakeupDatabase(fixture.databasePath);
  t.after(() => database.close());
  const repository = new WakeupRepository(database.connection);
  const planning = new FakePlanningBackend("planning.linear", [
    createWorkItem("issue-1"),
    createWorkItem("issue-2"),
  ]);
  const sweep = new ActionableSweepLoop({
    planning,
    repository,
    limit: 5,
    now: () => new Date("2026-04-15T20:00:00.000Z"),
  });

  const result = await sweep.runOnce();

  assert.deepEqual(planning.listInputs, [{ limit: 5 }]);
  assert.deepEqual(result, {
    candidateCount: 2,
    insertedCount: 2,
    coalescedCount: 0,
    issueIds: ["issue-1", "issue-2"],
  });

  const queued = repository.list("queued");
  assert.equal(queued.length, 2);
  assert.deepEqual(
    queued.map((event) => event.issueId).sort(),
    ["issue-1", "issue-2"],
  );
  const issueOne = queued.find((event) => event.issueId === "issue-1");
  assert.equal(issueOne?.dedupeKey, "linear:Issue:issue-1");
  assert.equal(issueOne?.action, "sweep");
  assert.match(issueOne?.deliveryId ?? "", /^sweep:2026-04-15T20:00:00.000Z:issue-1$/);
});

test("actionable sweep coalesces with existing webhook wakeups for the same issue", async (t) => {
  const fixture = createFixture(t);
  const database = openWakeupDatabase(fixture.databasePath);
  t.after(() => database.close());
  const repository = new WakeupRepository(database.connection);
  repository.enqueue(
    normalizeLinearWebhookEvent({
      headers: {
        "linear-delivery": "delivery-1",
        "linear-event": "Issue",
      },
      payload: {
        action: "update",
        type: "Issue",
        data: {
          id: "issue-1",
        },
      },
      receivedAt: "2026-04-15T20:00:00.000Z",
      payloadJson: JSON.stringify({ source: "webhook" }),
    }),
  );
  const planning = new FakePlanningBackend("planning.linear", [createWorkItem("issue-1")]);
  const sweep = new ActionableSweepLoop({
    planning,
    repository,
    limit: 5,
    now: () => new Date("2026-04-15T20:01:00.000Z"),
  });

  const result = await sweep.runOnce();

  assert.deepEqual(result, {
    candidateCount: 1,
    insertedCount: 0,
    coalescedCount: 1,
    issueIds: ["issue-1"],
  });

  const queued = repository.list("queued");
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.issueId, "issue-1");
  assert.equal(queued[0]?.coalescedCount, 1);
  assert.equal(queued[0]?.dedupeKey, "linear:Issue:issue-1");
});

test("actionable sweep start skips overlapping ticks while a run is still in flight", async (t) => {
  const fixture = createFixture(t);
  const database = openWakeupDatabase(fixture.databasePath);
  t.after(() => database.close());
  const repository = new WakeupRepository(database.connection);
  const firstListing = createDeferred<WorkItemRecord[]>();
  let intervalTick: (() => void) | undefined;
  let clearedTimer: unknown = null;
  const planning = new FakePlanningBackend("planning.linear", [], {
    listActionableWorkItems: async (input) => {
      planning.listInputs.push(input);
      return firstListing.promise;
    },
  });
  const sweep = new ActionableSweepLoop({
    planning,
    repository,
    limit: 5,
    now: () => new Date("2026-04-15T20:02:00.000Z"),
    setInterval: ((callback: () => void) => {
      intervalTick = callback;
      return "timer-id" as unknown as ReturnType<typeof globalThis.setInterval>;
    }) as typeof globalThis.setInterval,
    clearInterval: ((timer: unknown) => {
      clearedTimer = timer;
    }) as typeof globalThis.clearInterval,
  });

  sweep.start();
  intervalTick?.();
  intervalTick?.();
  intervalTick?.();

  assert.deepEqual(planning.listInputs, [{ limit: 5 }]);

  firstListing.resolve([createWorkItem("issue-1")]);
  await sweep.stop();

  assert.equal(clearedTimer, "timer-id");
  assert.equal(repository.list("queued").length, 1);
});

function createFixture(t: { after(callback: () => void): void }) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "orq-actionable-sweep-"));
  t.after(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  return {
    databasePath: path.join(rootDir, "orchestrator.sqlite"),
  };
}

class FakePlanningBackend extends PlanningBackend<PlanningProviderConfig> {
  readonly listInputs: ListActionableWorkItemsInput[] = [];

  constructor(
    kind: PlanningProviderConfig["kind"],
    private readonly actionable: WorkItemRecord[],
    private readonly overrides: {
      listActionableWorkItems?: (
        input: ListActionableWorkItemsInput,
      ) => Promise<WorkItemRecord[]>;
    } = {},
  ) {
    super(
      kind === "planning.linear"
        ? {
            name: "planning",
            family: "planning",
            kind,
            tokenEnv: "LINEAR_TOKEN",
            team: "Orqestrate",
            mapping: {},
          }
        : {
            name: "planning",
            family: "planning",
            kind,
            root: "/tmp/planning",
          },
    );
  }

  async validateConfig(): Promise<void> {}

  async listActionableWorkItems(
    input: ListActionableWorkItemsInput,
  ): Promise<WorkItemRecord[]> {
    if (this.overrides.listActionableWorkItems !== undefined) {
      return this.overrides.listActionableWorkItems(input);
    }

    this.listInputs.push(input);
    return this.actionable.slice(0, input.limit);
  }

  async getWorkItem(): Promise<WorkItemRecord | null> {
    throw new Error("Not implemented in test.");
  }

  async claimWorkItem(_input: ClaimWorkItemInput): Promise<WorkItemRecord> {
    throw new Error("Not implemented in test.");
  }

  async markWorkItemRunning(
    _input: MarkWorkItemRunningInput,
  ): Promise<WorkItemRecord> {
    throw new Error("Not implemented in test.");
  }

  async renewLease(_input: RenewLeaseInput): Promise<WorkItemRecord> {
    throw new Error("Not implemented in test.");
  }

  async transitionWorkItem(
    _input: TransitionWorkItemInput,
  ): Promise<WorkItemRecord> {
    throw new Error("Not implemented in test.");
  }

  async appendComment(_input: AppendCommentInput): Promise<void> {
    throw new Error("Not implemented in test.");
  }

  async buildDeepLink(): Promise<string | null> {
    return null;
  }
}

function createWorkItem(id: string): WorkItemRecord {
  return {
    id,
    identifier: id.toUpperCase(),
    title: `Work item ${id}`,
    description: null,
    status: "implement",
    phase: "implement",
    priority: 1,
    labels: [],
    url: `https://linear.app/orqestrate/issue/${id}`,
    parentId: null,
    dependencyIds: [],
    blockedByIds: [],
    blocksIds: [],
    artifactUrl: null,
    updatedAt: "2026-04-15T00:00:00.000Z",
    createdAt: "2026-04-15T00:00:00.000Z",
    orchestration: {
      state: "queued",
      owner: null,
      runId: null,
      leaseUntil: null,
      reviewOutcome: null,
      blockedReason: null,
      lastError: null,
      attemptCount: 0,
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}
