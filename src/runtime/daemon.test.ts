import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeDaemon } from "./daemon.js";
import {
  createRunInput,
  createRuntimeFixture,
  FakeProviderAdapter,
  FakeSessionSupervisor,
  waitForAsyncTurn,
  waitForRunStatus,
} from "./test-support.js";

test("runtime daemon dispatches queued runs under capacity and backfills after completion", async (t) => {
  const fixture = createRuntimeFixture(t);
  fixture.runtimeConfig.policy.maxConcurrentRuns = 1;
  fixture.runtimeConfig.policy.maxRunsPerProvider = 1;

  const supervisor = new FakeSessionSupervisor();
  const daemon = new RuntimeDaemon(fixture.runtimeConfig, {
    sessionSupervisor: supervisor,
    dispatcherIntervalMs: 5,
  });
  daemon.registerRuntimeAdapter("codex", () => new FakeProviderAdapter());
  daemon.start();
  t.after(() => daemon.stop());

  daemon.enqueueRun(createRunInput({ runId: "run-001", workItemId: "issue-1" }));
  daemon.enqueueRun(createRunInput({ runId: "run-002", workItemId: "issue-2" }));

  await waitForRunStatus(daemon, "run-001", "bootstrapping");
  assert.equal(daemon.getRun("run-002")?.status, "queued");

  const capacityWhileFirstIsActive = daemon.getCapacitySnapshot();
  assert.equal(capacityWhileFirstIsActive.global.active, 1);
  assert.equal(capacityWhileFirstIsActive.global.queued, 1);

  supervisor.emitOutput("session-1", "READY\n");
  supervisor.emitExit("session-1", 0, null);
  await waitForAsyncTurn();
  await waitForRunStatus(daemon, "run-002", "bootstrapping");

  const capacityAfterBackfill = daemon.getCapacitySnapshot();
  assert.equal(capacityAfterBackfill.global.active, 1);
  assert.equal(capacityAfterBackfill.global.queued, 0);

  supervisor.emitOutput("session-2", "READY\n");
  supervisor.emitExit("session-2", 0, null);
  await waitForRunStatus(daemon, "run-002", "completed");
});
