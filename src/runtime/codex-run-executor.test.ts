import assert from "node:assert/strict";
import test from "node:test";

import { CodexProviderAdapter } from "./adapters/codex-adapter.js";
import { openRuntimeDatabase } from "./persistence/database.js";
import { RuntimeRepository } from "./persistence/runtime-repository.js";
import { RunExecutor } from "./run-executor.js";
import { RuntimeAdapterRegistry } from "./runtime-adapter-registry.js";
import {
  createRunInput,
  createRuntimeFixture,
  FakeSessionSupervisor,
  waitForAsyncTurn,
} from "./test-support.js";
import type { ExecutableRunRecord } from "./types.js";

test("run executor completes a Codex-backed run through waiting-human and resume", async (t) => {
  const fixture = createRuntimeFixture(t);
  const database = openRuntimeDatabase(fixture.runtimeConfig.databasePath);
  t.after(() => database.close());

  const repository = new RuntimeRepository(database.connection);
  const registry = new RuntimeAdapterRegistry().register(
    "codex",
    () => new CodexProviderAdapter(),
  );
  const supervisor = new FakeSessionSupervisor();
  const executor = new RunExecutor(
    repository,
    registry,
    supervisor,
    fixture.runtimeConfig.runtimeLogDir,
    {
      heartbeatFlushIntervalMs: 5,
      quietHeartbeatIntervalMs: 20,
      cancelGracePeriodMs: 5,
    },
  );

  repository.enqueueRun(
    createRunInput({
      runId: "run-codex-001",
      workItemId: "issue-codex-001",
      workItemIdentifier: "ORQ-34",
    }),
  );
  const claimedRun = repository.claimNextQueuedRun({
    runtimeOwner: "runtime-daemon",
  }) as ExecutableRunRecord;

  const execution = executor.executeClaimedRun(claimedRun);
  await waitForAsyncTurn();

  assert.equal(repository.getRun(claimedRun.runId)?.status, "bootstrapping");

  supervisor.emitOutput("session-1", "Welcome to Codex\n› ");
  await waitForAsyncTurn();
  assert.equal(repository.getRun(claimedRun.runId)?.status, "running");

  supervisor.emitOutput(
    "session-1",
    [
      "",
      "STATUS: waiting_human",
      "SUMMARY: Need a human decision.",
      "REQUESTED_HUMAN_INPUT: Should I keep the adapter built-in?",
    ].join("\n"),
  );
  await waitForAsyncTurn();
  assert.equal(repository.getRun(claimedRun.runId)?.status, "waiting_human");

  const resumedRun = await executor.submitHumanInput(claimedRun.runId, {
    kind: "answer",
    author: "Kimball Hill",
    message: "Yes, keep Codex as the default built-in adapter.",
  });
  assert.equal(resumedRun.status, "running");

  supervisor.emitOutput(
    "session-1",
    [
      "",
      "STATUS: waiting_human",
      "SUMMARY: Need a human decision.",
      "REQUESTED_HUMAN_INPUT: Should I keep the adapter built-in?",
    ].join("\n"),
  );
  await waitForAsyncTurn();
  assert.equal(repository.getRun(claimedRun.runId)?.status, "waiting_human");

  const secondResume = await executor.submitHumanInput(claimedRun.runId, {
    kind: "answer",
    author: "Kimball Hill",
    message: "Still yes. Keep it built in.",
  });
  assert.equal(secondResume.status, "running");

  supervisor.emitOutput(
    "session-1",
    [
      "",
      "STATUS: completed",
      "SUMMARY: Codex adapter completed successfully.",
      "VERIFICATION:",
      "- npm run test",
      "- passed",
    ].join("\n"),
  );
  supervisor.emitExit("session-1", 0, null);

  const completedRun = await execution;

  assert.equal(completedRun.status, "completed");
  assert.deepEqual(completedRun.outcome?.verification, {
    commands: ["npm run test"],
    passed: true,
    notes: "- npm run test\n- passed",
  });
  assert.equal(
    completedRun.outcome?.summary,
    "Codex adapter completed successfully.",
  );

  const eventTypes = repository
    .listRunEvents(claimedRun.runId)
    .map((event) => event.eventType);
  assert.ok(eventTypes.includes("session_ready"));
  assert.ok(eventTypes.includes("waiting_human"));
  assert.ok(eventTypes.includes("human_input_received"));
  assert.ok(eventTypes.includes("run_completed"));
});
