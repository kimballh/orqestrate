import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeDaemon } from "./daemon.js";
import { RuntimeAdapterRegistry } from "./runtime-adapter-registry.js";
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
    adapterRegistry: new RuntimeAdapterRegistry(),
    sessionSupervisor: supervisor,
    dispatcherIntervalMs: 5,
  });
  daemon.registerRuntimeAdapter("codex", () => new FakeProviderAdapter());
  daemon.start();
  t.after(async () => daemon.stop());

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
test("runtime daemon uses the built-in Claude adapter for waiting-human resume flows", async (t) => {
  const fixture = createRuntimeFixture(t);
  const supervisor = new FakeSessionSupervisor();
  const daemon = new RuntimeDaemon(fixture.runtimeConfig, {
    sessionSupervisor: supervisor,
    dispatcherIntervalMs: 5,
  });
  daemon.start();
  t.after(async () => daemon.stop());

  daemon.enqueueRun(
    createRunInput({
      runId: "run-claude-001",
      workItemId: "issue-claude-1",
      provider: "claude",
    }),
  );

  await waitForRunStatus(daemon, "run-claude-001", "bootstrapping");

  supervisor.emitOutput("session-1", "Welcome to Claude Code\n> ");
  await waitForRunStatus(daemon, "run-claude-001", "running");

  supervisor.emitOutput(
    "session-1",
    `STATUS: waiting_human
SUMMARY:
Need a decision.

REQUESTED_HUMAN_INPUT:
Should I continue?
`,
  );
  await waitForRunStatus(daemon, "run-claude-001", "waiting_human");

  const resumedRun = await daemon.submitHumanInput("run-claude-001", {
    kind: "answer",
    message: "Yes, continue.",
    author: "Kimball Hill",
  });
  assert.equal(resumedRun.status, "running");

  supervisor.emitOutput(
    "session-1",
    `STATUS: completed
SUMMARY:
Claude finished the implementation.

VERIFICATION:
- \`npm run check\`
- passed
`,
  );
  supervisor.emitExit("session-1", 0, null);

  await waitForRunStatus(daemon, "run-claude-001", "completed");
  const completedRun = daemon.getRun("run-claude-001");
  assert.equal(completedRun?.outcome?.summary, "Claude finished the implementation.");
  assert.deepEqual(completedRun?.outcome?.verification, {
    commands: ["npm run check"],
    passed: true,
    notes: "- `npm run check`\n- passed",
  });
});

test("runtime daemon registers the built-in runtime adapters by default", (t) => {
  const fixture = createRuntimeFixture(t);
  const daemon = new RuntimeDaemon(fixture.runtimeConfig);

  assert.deepEqual(daemon.adapterRegistry.listProviders(), ["claude", "codex"]);
});
