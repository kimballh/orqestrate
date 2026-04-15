import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { PlanningBackend } from "../../core/planning-backend.js";
import type { WorkItemRecord } from "../../domain-model.js";

import {
  createFutureLease,
  createProviderErrorFixture,
  createRunId,
  createWorkItemRecordFixture,
} from "./fixtures.js";

type Awaitable<T> = Promise<T> | T;

export type PlanningContractSetup = {
  backend: PlanningBackend;
  cleanup?: () => Awaitable<void>;
  getCommentBodies(workItemId: string): Promise<string[]>;
  getExpectedDeepLink(workItemId: string): Awaitable<string | null>;
};

export type PlanningContractHarness = {
  providerName: string;
  setup(input: { workItems: WorkItemRecord[] }): Promise<PlanningContractSetup>;
};

export function definePlanningBackendContract(
  harness: PlanningContractHarness,
): void {
  test(`${harness.providerName} satisfies the shared planning backend contract`, async (t) => {
    await t.test("lists actionable work items and resolves missing ids", async (t) => {
      const workItems = [
        createWorkItemRecordFixture({
          id: "ISSUE-1",
          title: "Oldest urgent issue",
          status: "implement",
          phase: "implement",
          priority: 1,
          updatedAt: "2026-04-14T00:00:00.000Z",
        }),
        createWorkItemRecordFixture({
          id: "ISSUE-2",
          title: "Leased issue",
          status: "implement",
          phase: "implement",
          priority: 1,
          updatedAt: "2026-04-14T00:10:00.000Z",
          orchestration: {
            state: "running",
            owner: "orchestrator-1",
            runId: createRunId("leased"),
            leaseUntil: createFutureLease("15"),
          },
        }),
        createWorkItemRecordFixture({
          id: "ISSUE-3",
          title: "Blocked issue",
          status: "plan",
          phase: "plan",
          priority: 2,
          blockedByIds: ["ISSUE-4"],
          updatedAt: "2026-04-14T00:05:00.000Z",
        }),
        createWorkItemRecordFixture({
          id: "ISSUE-4",
          title: "Open blocker",
          status: "review",
          phase: "review",
          priority: 2,
          updatedAt: "2026-04-14T00:01:00.000Z",
        }),
        createWorkItemRecordFixture({
          id: "ISSUE-5",
          title: "Backlog issue",
          status: "backlog",
          phase: "none",
          priority: 0,
          updatedAt: "2026-04-14T00:02:00.000Z",
        }),
        createWorkItemRecordFixture({
          id: "ISSUE-6",
          title: "Second actionable issue",
          status: "plan",
          phase: "plan",
          priority: 2,
          updatedAt: "2026-04-14T00:02:00.000Z",
        }),
      ];
      const setup = await useHarness(t, harness, workItems);

      assert.equal(await setup.backend.getWorkItem("missing"), null);

      const workItem = await setup.backend.getWorkItem("ISSUE-1");
      assert.equal(workItem?.title, "Oldest urgent issue");

      const actionable = await setup.backend.listActionableWorkItems({ limit: 10 });
      assert.deepEqual(
        actionable.map((item) => item.id),
        ["ISSUE-1", "ISSUE-4", "ISSUE-6"],
      );

      const planOnly = await setup.backend.listActionableWorkItems({
        phases: ["plan"],
        limit: 10,
      });
      assert.deepEqual(planOnly.map((item) => item.id), ["ISSUE-6"]);
    });

    await t.test("claims actionable work items and rejects invalid claims", async (t) => {
      const workItems = [
        createWorkItemRecordFixture({
          id: "ISSUE-1",
          status: "implement",
          phase: "implement",
        }),
        createWorkItemRecordFixture({
          id: "ISSUE-2",
          status: "implement",
          phase: "implement",
          orchestration: {
            state: "claimed",
            owner: "orchestrator-1",
            runId: createRunId("active"),
            leaseUntil: createFutureLease("00"),
          },
        }),
        createWorkItemRecordFixture({
          id: "ISSUE-3",
          status: "backlog",
          phase: "none",
        }),
        createWorkItemRecordFixture({
          id: "ISSUE-4",
          status: "plan",
          phase: "plan",
        }),
        createWorkItemRecordFixture({
          id: "ISSUE-5",
          status: "implement",
          phase: "implement",
          blockedByIds: ["ISSUE-6"],
        }),
        createWorkItemRecordFixture({
          id: "ISSUE-6",
          status: "plan",
          phase: "plan",
        }),
      ];
      const setup = await useHarness(t, harness, workItems);

      const claimed = await setup.backend.claimWorkItem({
        id: "ISSUE-1",
        phase: "implement",
        owner: "orchestrator-1",
        runId: createRunId("claim-1"),
        leaseUntil: createFutureLease("05"),
      });

      assert.equal(claimed.orchestration.state, "claimed");
      assert.equal(claimed.orchestration.owner, "orchestrator-1");
      assert.equal(claimed.orchestration.runId, createRunId("claim-1"));
      assert.equal(claimed.orchestration.leaseUntil, createFutureLease("05"));
      assert.equal(claimed.orchestration.attemptCount, 1);

      await assert.rejects(
        () =>
          setup.backend.claimWorkItem({
            id: "ISSUE-2",
            phase: "implement",
            owner: "orchestrator-2",
            runId: createRunId("claim-2"),
            leaseUntil: createFutureLease("10"),
          }),
        /active lease/i,
      );

      await assert.rejects(
        () =>
          setup.backend.claimWorkItem({
            id: "ISSUE-3",
            phase: "implement",
            owner: "orchestrator-2",
            runId: createRunId("claim-3"),
            leaseUntil: createFutureLease("10"),
          }),
        /cannot be claimed/i,
      );

      await assert.rejects(
        () =>
          setup.backend.claimWorkItem({
            id: "ISSUE-4",
            phase: "implement",
            owner: "orchestrator-2",
            runId: createRunId("claim-4"),
            leaseUntil: createFutureLease("10"),
          }),
        /phase 'plan', not 'implement'/i,
      );

      await assert.rejects(
        () =>
          setup.backend.claimWorkItem({
            id: "ISSUE-5",
            phase: "implement",
            owner: "orchestrator-2",
            runId: createRunId("claim-5"),
            leaseUntil: createFutureLease("10"),
          }),
        /open blockers/i,
      );
    });

    await t.test("enforces lease ownership for running and renewal operations", async (t) => {
      const setup = await useHarness(t, harness, [
        createWorkItemRecordFixture({
          id: "ISSUE-1",
          status: "implement",
          phase: "implement",
          orchestration: {
            state: "claimed",
            owner: "orchestrator-1",
            runId: createRunId("owned"),
            leaseUntil: createFutureLease("00"),
          },
        }),
      ]);

      await assert.rejects(
        () =>
          setup.backend.markWorkItemRunning({
            id: "ISSUE-1",
            owner: "orchestrator-2",
            runId: createRunId("owned"),
            leaseUntil: createFutureLease("05"),
          }),
        /owned by/i,
      );

      const running = await setup.backend.markWorkItemRunning({
        id: "ISSUE-1",
        owner: "orchestrator-1",
        runId: createRunId("owned"),
        leaseUntil: createFutureLease("05"),
      });

      assert.equal(running.orchestration.state, "running");
      assert.equal(running.orchestration.leaseUntil, createFutureLease("05"));

      await assert.rejects(
        () =>
          setup.backend.renewLease({
            id: "ISSUE-1",
            owner: "orchestrator-1",
            runId: createRunId("other"),
            leaseUntil: createFutureLease("10"),
          }),
        /leased to run/i,
      );

      const renewed = await setup.backend.renewLease({
        id: "ISSUE-1",
        owner: "orchestrator-1",
        runId: createRunId("owned"),
        leaseUntil: createFutureLease("10"),
      });

      assert.equal(renewed.orchestration.state, "running");
      assert.equal(renewed.orchestration.leaseUntil, createFutureLease("10"));
    });

    await t.test("applies shared transition semantics for blocked, review, done, and failed states", async (t) => {
      const setup = await useHarness(t, harness, [
        createWorkItemRecordFixture({
          id: "ISSUE-1",
          status: "implement",
          phase: "implement",
          orchestration: {
            state: "running",
            owner: "orchestrator-1",
            runId: createRunId("blocked"),
            leaseUntil: createFutureLease("00"),
            attemptCount: 2,
          },
        }),
        createWorkItemRecordFixture({
          id: "ISSUE-2",
          status: "review",
          phase: "review",
          orchestration: {
            state: "running",
            owner: "reviewer-1",
            runId: createRunId("done"),
            leaseUntil: createFutureLease("05"),
            reviewOutcome: "changes_requested",
            attemptCount: 3,
          },
        }),
        createWorkItemRecordFixture({
          id: "ISSUE-3",
          status: "implement",
          phase: "implement",
          orchestration: {
            state: "completed",
            owner: null,
            runId: createRunId("review"),
            leaseUntil: null,
            reviewOutcome: "changes_requested",
            attemptCount: 2,
          },
        }),
        createWorkItemRecordFixture({
          id: "ISSUE-4",
          status: "implement",
          phase: "implement",
          orchestration: {
            state: "running",
            owner: "orchestrator-1",
            runId: createRunId("failed"),
            leaseUntil: createFutureLease("08"),
            attemptCount: 4,
          },
        }),
      ]);

      const blocked = await setup.backend.transitionWorkItem({
        id: "ISSUE-1",
        nextStatus: "blocked",
        nextPhase: "none",
        state: "waiting_human",
        blockedReason: "missing credentials",
        runId: createRunId("blocked"),
      });

      assert.equal(blocked.status, "blocked");
      assert.equal(blocked.phase, "implement");
      assert.equal(blocked.orchestration.owner, null);
      assert.equal(blocked.orchestration.leaseUntil, null);
      assert.equal(blocked.orchestration.blockedReason, "missing credentials");

      const done = await setup.backend.transitionWorkItem({
        id: "ISSUE-2",
        nextStatus: "done",
        nextPhase: "none",
        state: "completed",
        runId: createRunId("done"),
      });

      assert.equal(done.status, "done");
      assert.equal(done.phase, "none");
      assert.equal(done.orchestration.owner, null);
      assert.equal(done.orchestration.leaseUntil, null);
      assert.equal(done.orchestration.reviewOutcome, "none");
      assert.equal(done.orchestration.attemptCount, 0);

      const movedToReview = await setup.backend.transitionWorkItem({
        id: "ISSUE-3",
        nextStatus: "review",
        nextPhase: "review",
        state: "completed",
        runId: createRunId("review"),
      });

      assert.equal(movedToReview.status, "review");
      assert.equal(movedToReview.phase, "review");
      assert.equal(movedToReview.orchestration.reviewOutcome, "none");
      assert.equal(movedToReview.orchestration.attemptCount, 0);

      const providerError = createProviderErrorFixture({
        providerFamily: "planning",
        providerKind: "planning.local_files",
        message: "Mutation failed in the provider contract.",
      });
      const failed = await setup.backend.transitionWorkItem({
        id: "ISSUE-4",
        nextStatus: "implement",
        nextPhase: "implement",
        state: "failed",
        lastError: providerError,
        runId: createRunId("failed"),
      });

      assert.equal(failed.status, "implement");
      assert.equal(failed.phase, "implement");
      assert.equal(failed.orchestration.state, "failed");
      assert.equal(failed.orchestration.owner, null);
      assert.equal(failed.orchestration.leaseUntil, null);
      assert.deepEqual(failed.orchestration.lastError, providerError);
    });

    await t.test("persists comments and deep links through the shared surface", async (t) => {
      const setup = await useHarness(t, harness, [
        createWorkItemRecordFixture({
          id: "ISSUE-1",
          status: "plan",
          phase: "plan",
        }),
      ]);

      await setup.backend.appendComment({
        id: "ISSUE-1",
        body: "Implemented claim and transition writes.",
      });

      assert.deepEqual(await setup.getCommentBodies("ISSUE-1"), [
        "Implemented claim and transition writes.",
      ]);
      assert.equal(await setup.backend.buildDeepLink("missing"), null);
      assert.equal(
        await setup.backend.buildDeepLink("ISSUE-1"),
        await setup.getExpectedDeepLink("ISSUE-1"),
      );
    });
  });
}

async function useHarness(
  t: TestContext,
  harness: PlanningContractHarness,
  workItems: WorkItemRecord[],
): Promise<PlanningContractSetup> {
  const setup = await harness.setup({ workItems });

  if (setup.cleanup !== undefined) {
    t.after(async () => {
      await setup.cleanup?.();
    });
  }

  return setup;
}
