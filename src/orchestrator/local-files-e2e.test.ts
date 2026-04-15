import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { bootstrapActiveProfile } from "../core/bootstrap.js";
import type { WorkItemRecord } from "../domain-model.js";
import { RuntimeApiServer } from "../runtime/api/server.js";
import { RuntimeDaemon } from "../runtime/daemon.js";
import { RuntimeAdapterRegistry } from "../runtime/runtime-adapter-registry.js";
import {
  HttpRuntimeApiClient,
} from "./runtime-client.js";
import { executeClaimedRun } from "./execute-run.js";
import {
  ScriptedProviderAdapter,
  ScriptedSessionSupervisor,
} from "../runtime/test-support.js";
import { createLocalFilesE2eFixture } from "../test/local-e2e-fixture.js";
import { resolveRuntimeConfig } from "../runtime/config.js";

test("executeClaimedRun completes the local_files happy path end to end", async (t) => {
  const fixture = await createLocalFilesE2eFixture(t);
  const { planning, context } = await bootstrapActiveProfile(fixture.loadedConfig);

  const actionableBefore = await planning.listActionableWorkItems({
    phases: ["implement"],
    limit: 10,
  });
  assert.deepEqual(actionableBefore.map((item) => item.id), [fixture.workItem.id]);

  const supervisor = new ScriptedSessionSupervisor([
    {
      kind: "output",
      chunk: "READY\n",
      delayMs: 5,
    },
    {
      kind: "output",
      chunk: "PROGRESS local e2e fixture complete\n",
      delayMs: 15,
    },
    {
      kind: "exit",
      exitCode: 0,
      delayMs: 40,
    },
  ]);
  const daemon = new RuntimeDaemon(resolveRuntimeConfig(fixture.loadedConfig), {
    adapterRegistry: new RuntimeAdapterRegistry(),
    sessionSupervisor: supervisor,
    dispatcherIntervalMs: 5,
  });
  daemon.registerRuntimeAdapter(
    "codex",
    () =>
      new ScriptedProviderAdapter({
        summary: "Local-only fixture suite passed.",
        details:
          "Validated real local planning/context providers with a live runtime service.",
        verification: {
          commands: ["tsx --test src/orchestrator/local-files-e2e.test.ts"],
          passed: true,
          notes:
            "The local_files end-to-end fixture completed through planning, runtime, and context write-back.",
        },
        artifactMarkdown: [
          "## Implementation Summary",
          "",
          "- Exercised the real `planning.local_files` provider.",
          "- Exercised the real `context.local_files` provider.",
          "- Verified runtime submission and outcome write-back through the live API.",
        ].join("\n"),
      }),
  );
  daemon.start();

  const apiServer = new RuntimeApiServer(daemon, {
    kind: "tcp",
    host: "127.0.0.1",
    port: 0,
  });
  await apiServer.start();
  t.after(async () => {
    if (apiServer.isListening) {
      await apiServer.stop();
    }
    await daemon.stop();
  });

  const endpoint = new URL(apiServer.info.endpoint);
  const runtime = new HttpRuntimeApiClient({
    listenOptions: {
      kind: "tcp",
      host: endpoint.hostname,
      port: Number.parseInt(endpoint.port, 10),
    },
    requestTimeoutMs: 5_000,
  });

  const result = await executeClaimedRun(
    {
      planning,
      context,
      loadedConfig: fixture.loadedConfig,
      runtime,
      now: () => new Date(),
      eventPollWaitMs: 5,
      leaseSafetyWindowMs: 10_000,
    },
    {
      workItemId: fixture.workItem.id,
      provider: "codex",
      repoRoot: fixture.workspaceDir,
      owner: "orchestrator:local-e2e",
      requestedBy: "Kimball Hill",
      createRunId: () => "run-orq-49-e2e",
      now: new Date(),
      leaseDurationMs: 60_000,
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok || !("execution" in result)) {
    assert.fail("Expected the local e2e run to complete successfully.");
  }

  const execution = result.execution;
  const artifactPath = execution.writeback.artifact?.url;
  assert.equal(execution.watched.run.status, "completed");
  assert.equal(execution.writeback.workItem.status, "review");
  assert.equal(execution.writeback.workItem.phase, "review");
  assert.ok(artifactPath);

  const persistedWorkItem = readJson<WorkItemRecord>(
    path.join(fixture.planningRoot, "issues", `${fixture.workItem.id}.json`),
  );
  assert.equal(persistedWorkItem.status, "review");
  assert.equal(persistedWorkItem.phase, "review");
  assert.equal(persistedWorkItem.orchestration.state, "queued");
  assert.equal(persistedWorkItem.orchestration.runId, execution.prepared.runId);

  const comments = readFileSync(
    path.join(fixture.planningRoot, "comments", `${fixture.workItem.id}.md`),
    "utf8",
  );
  assert.match(comments, /Implement run completed/);
  assert.match(comments, /Local-only fixture suite passed\./);
  assert.match(comments, /tsx --test src\/orchestrator\/local-files-e2e\.test\.ts/);

  const artifactMarkdown = readFileSync(artifactPath, "utf8");
  assert.match(artifactMarkdown, /## Implementation Summary/);
  assert.match(artifactMarkdown, /real `planning\.local_files` provider/);
  assert.match(artifactMarkdown, /live API/);

  const runLedger = readJson<{
    status: string;
    summary: string | null;
    verification: {
      commands: string[];
      passed: boolean;
      notes: string | null;
    } | null;
  }>(path.join(fixture.contextRoot, "runs", `${execution.prepared.runId}.json`));
  assert.equal(runLedger.status, "completed");
  assert.equal(runLedger.summary, "Local-only fixture suite passed.");
  assert.deepEqual(runLedger.verification, {
    commands: ["tsx --test src/orchestrator/local-files-e2e.test.ts"],
    passed: true,
    notes:
      "The local_files end-to-end fixture completed through planning, runtime, and context write-back.",
  });

  const evidence = readFileSync(
    path.join(fixture.contextRoot, "evidence", `${execution.prepared.runId}.md`),
    "utf8",
  );
  assert.match(evidence, /## .* - Run Outcome/);
  assert.match(evidence, /Status: completed/);
  assert.match(evidence, /Verification:/);

  const actionableAfter = await planning.listActionableWorkItems({
    phases: ["implement"],
    limit: 10,
  });
  assert.deepEqual(actionableAfter, []);

  const runtimeRun = daemon.getRun(execution.prepared.runId);
  assert.ok(runtimeRun);
  assert.equal(runtimeRun.status, "completed");
});

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}
