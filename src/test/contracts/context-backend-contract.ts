import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { ContextBackend } from "../../core/context-backend.js";

import {
  createProviderErrorFixture,
  createWorkItemRecordFixture,
} from "./fixtures.js";

type Awaitable<T> = Promise<T> | T;

export type ContextContractSetup = {
  backend: ContextBackend;
  cleanup?: () => Awaitable<void>;
};

export type ContextContractHarness = {
  providerName: string;
  setup(): Promise<ContextContractSetup>;
};

export function defineContextBackendContract(
  harness: ContextContractHarness,
): void {
  test(`${harness.providerName} satisfies the shared context backend contract`, async (t) => {
    await t.test("creates artifacts idempotently and returns null before creation", async (t) => {
      const workItem = createWorkItemRecordFixture({
        id: "ISSUE-ARTIFACT",
        identifier: "ORQ-50",
        title: "Contract test artifact",
        status: "implement",
        phase: "implement",
      });
      const setup = await useHarness(t, harness);

      assert.equal(await setup.backend.getArtifactByWorkItemId(workItem.id), null);

      const firstArtifact = await setup.backend.ensureArtifact({ workItem });
      const secondArtifact = await setup.backend.ensureArtifact({ workItem });

      assert.deepEqual(secondArtifact, firstArtifact);
      assert.equal(firstArtifact.workItemId, workItem.id);
      assert.equal(firstArtifact.phase, "none");
      assert.equal(firstArtifact.state, "draft");
      assert.equal(firstArtifact.planReady, false);
      assert.equal(firstArtifact.verificationEvidencePresent, false);
    });

    await t.test("writes phase artifacts and reloads them through the shared bundle", async (t) => {
      const workItem = createWorkItemRecordFixture({
        id: "ISSUE-PLAN",
        identifier: "ORQ-50",
        title: "Contract plan artifact",
        status: "implement",
        phase: "implement",
      });
      const setup = await useHarness(t, harness);

      const artifact = await setup.backend.ensureArtifact({ workItem });
      const updated = await setup.backend.writePhaseArtifact({
        workItem,
        artifact,
        phase: "plan",
        content: "Implementation plan for ORQ-50.",
        summary: "Plan is ready.",
      });
      const storedArtifact = await setup.backend.getArtifactByWorkItemId(workItem.id);
      const bundle = await setup.backend.loadContextBundle({
        workItem,
        artifact: storedArtifact,
        phase: "plan",
      });

      assert.equal(updated.phase, "plan");
      assert.equal(updated.state, "ready");
      assert.equal(updated.planReady, true);
      assert.equal(updated.summary, "Plan is ready.");
      assert.ok(storedArtifact);
      assert.equal(storedArtifact.summary, "Plan is ready.");
      assert.match(bundle.contextText, /Implementation plan for ORQ-50\./);
      assert.match(bundle.references.map((reference) => reference.kind).join(","), /artifact/);
    });

    await t.test("persists run ledgers, summaries, and evidence through the shared interface", async (t) => {
      const workItem = createWorkItemRecordFixture({
        id: "ISSUE-RUN",
        identifier: "ORQ-50",
        title: "Contract implementation artifact",
        status: "implement",
        phase: "implement",
      });
      const setup = await useHarness(t, harness);

      const artifact = await setup.backend.ensureArtifact({ workItem });
      await setup.backend.writePhaseArtifact({
        workItem,
        artifact,
        phase: "implement",
        content: "Implemented the shared contract suite.",
        summary: "Implementation landed.",
      });

      const createdRun = await setup.backend.createRunLedgerEntry({
        runId: "run-1",
        workItem,
        phase: "implement",
        status: "running",
      });
      const finalizedRun = await setup.backend.finalizeRunLedgerEntry({
        runId: "run-1",
        status: "completed",
        summary: "Checks passed.",
      });

      await setup.backend.appendEvidence({
        runId: "run-1",
        workItemId: workItem.id,
        section: "Verification",
        content: "npm run check",
      });

      const storedArtifact = await setup.backend.getArtifactByWorkItemId(workItem.id);
      const bundle = await setup.backend.loadContextBundle({
        workItem,
        artifact: storedArtifact,
        phase: "implement",
      });

      assert.equal(createdRun.workItemId, workItem.id);
      assert.equal(finalizedRun.status, "completed");
      assert.equal(finalizedRun.summary, "Checks passed.");
      assert.ok(storedArtifact);
      assert.equal(storedArtifact.verificationEvidencePresent, true);
      assert.match(bundle.contextText, /Implemented the shared contract suite\./);
      assert.match(bundle.contextText, /# Recent Run History/);
      assert.match(bundle.contextText, /run-1/);
      assert.ok(bundle.references.some((reference) => reference.kind === "artifact"));
      assert.ok(bundle.references.some((reference) => reference.kind === "run_ledger"));
    });

    await t.test("handles duplicate and missing run ledger writes consistently", async (t) => {
      const workItem = createWorkItemRecordFixture({
        id: "ISSUE-FAIL",
        identifier: "ORQ-50",
        title: "Contract failure artifact",
        status: "implement",
        phase: "implement",
      });
      const setup = await useHarness(t, harness);

      await setup.backend.ensureArtifact({ workItem });
      await setup.backend.createRunLedgerEntry({
        runId: "run-failed",
        workItem,
        phase: "implement",
        status: "running",
      });

      await assert.rejects(
        () =>
          setup.backend.createRunLedgerEntry({
            runId: "run-failed",
            workItem,
            phase: "implement",
            status: "running",
          }),
        /already exists/i,
      );

      await assert.rejects(
        () =>
          setup.backend.finalizeRunLedgerEntry({
            runId: "missing-run",
            status: "failed",
          }),
        /does not exist/i,
      );

      const error = createProviderErrorFixture({
        providerFamily: "context",
        providerKind: "context.notion",
        message: "Provider write failed during contract verification.",
      });
      const failedRun = await setup.backend.finalizeRunLedgerEntry({
        runId: "run-failed",
        status: "failed",
        summary: "Provider write failed.",
        error,
      });

      assert.equal(failedRun.status, "failed");
      assert.equal(failedRun.summary, "Provider write failed.");
      assert.deepEqual(failedRun.error, error);
    });
  });
}

async function useHarness(
  t: TestContext,
  harness: ContextContractHarness,
): Promise<ContextContractSetup> {
  const setup = await harness.setup();

  if (setup.cleanup !== undefined) {
    t.after(async () => {
      await setup.cleanup?.();
    });
  }

  return setup;
}
