import assert from "node:assert/strict";
import test from "node:test";

import type { LoadedConfig } from "../config/types.js";
import type { RuntimeClient } from "../orchestrator/runtime-client.js";
import type { RuntimeApiRun } from "../runtime/api/types.js";
import { RuntimeDaemon } from "../runtime/daemon.js";
import { RuntimeAdapterRegistry } from "../runtime/runtime-adapter-registry.js";
import { RuntimeApiServer } from "../runtime/api/server.js";
import {
  createRunInput,
  createRuntimeFixture,
  FakeProviderAdapter,
  FakeSessionSupervisor,
} from "../runtime/test-support.js";
import { HttpRuntimeApiClient } from "../orchestrator/runtime-client.js";
import { runCli } from "../index.js";

test("run list renders operator-friendly summaries and work-item filtering", async () => {
  const listRunsCalls: Array<Record<string, unknown>> = [];
  const result = await invokeCli(
    ["run", "list", "--work-item", "issue-48"],
    {
      loadConfig: async () => ({}) as LoadedConfig,
      createRuntimeClient: () => ({
        createRun: async () => {
          throw new Error("unused");
        },
        getRun: async () => {
          throw new Error("unused");
        },
        listRuns: async (query) => {
          listRunsCalls.push(query ?? {});
          return {
            runs: [
              createRun({
                runId: "run-048",
                workItemId: "issue-48",
                workItemIdentifier: "ORQ-48",
                status: "failed",
                outcome: {
                  code: "provider_bootstrap_timeout",
                  summary: "Provider failed to bootstrap in time.",
                  error: null,
                },
              }),
            ],
            nextCursor: null,
          };
        },
        listRunEvents: async () => {
          throw new Error("unused");
        },
        getHealth: async () => {
          throw new Error("unused");
        },
      }),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^Recent Runs$/m);
  assert.match(result.stdout, /run-048 \| ORQ-48 \| implement \| codex \| failed/);
  assert.match(result.stdout, /Provider failed to bootstrap in time\./);
  assert.equal(listRunsCalls.length, 1);
  assert.equal(listRunsCalls[0]?.workItemId, "issue-48");
});

test("run inspect emits focused JSON diagnostics", async () => {
  const eventQueries: Array<Record<string, unknown>> = [];
  const result = await invokeCli(
    [
      "run",
      "inspect",
      "run-048",
      "--view",
      "failure",
      "--format",
      "json",
      "--events-limit",
      "3",
    ],
    {
      loadConfig: async () => ({}) as LoadedConfig,
      createRuntimeClient: () => ({
        createRun: async () => {
          throw new Error("unused");
        },
        getRun: async () =>
          createRun({
            runId: "run-048",
            status: "failed",
            outcome: {
              code: "provider_bootstrap_timeout",
              summary: "Provider failed to bootstrap in time.",
              error: {
                providerFamily: "runtime",
                providerKind: "codex",
                code: "timeout",
                message: "Provider bootstrap timed out.",
                retryable: true,
                details: null,
              },
            },
            completedAt: "2026-04-15T18:05:00.000Z",
          }),
        listRuns: async () => ({
          runs: [],
          nextCursor: null,
        }),
        listRunEvents: async (_runId, query) => {
          eventQueries.push(query ?? {});
          if ((query?.after ?? 0) === 0) {
            return [
              {
                seq: 1,
                runId: "run-048",
                eventType: "run_enqueued",
                occurredAt: "2026-04-15T18:00:00.000Z",
                level: "info",
                source: "api",
                payload: {},
              },
              {
                seq: 2,
                runId: "run-048",
                eventType: "run_admitted",
                occurredAt: "2026-04-15T18:01:00.000Z",
                level: "info",
                source: "scheduler",
                payload: {},
              },
              {
                seq: 3,
                runId: "run-048",
                eventType: "session_started",
                occurredAt: "2026-04-15T18:02:00.000Z",
                level: "info",
                source: "supervisor",
                payload: {},
              },
            ];
          }

          if ((query?.after ?? 0) === 3) {
            return [
              {
                seq: 4,
                runId: "run-048",
                eventType: "session_ready",
                occurredAt: "2026-04-15T18:03:00.000Z",
                level: "info",
                source: "provider",
                payload: {},
              },
              {
                seq: 5,
                runId: "run-048",
                eventType: "progress_update",
                occurredAt: "2026-04-15T18:03:30.000Z",
                level: "info",
                source: "provider",
                payload: { chunk: "Still running" },
              },
              {
                seq: 6,
                runId: "run-048",
                eventType: "runtime_issue_detected",
                occurredAt: "2026-04-15T18:04:00.000Z",
                level: "warn",
                source: "provider",
                payload: {
                  code: "provider_bootstrap_timeout",
                  message: "Provider bootstrap timed out.",
                  retryable: true,
                },
              },
            ];
          }

          return [
            {
              seq: 7,
              runId: "run-048",
              eventType: "run_failed",
              occurredAt: "2026-04-15T18:05:00.000Z",
              level: "info",
              source: "provider",
              payload: { status: "failed" },
            },
          ];
        },
        getHealth: async () => {
          throw new Error("unused");
        },
      }),
    },
  );

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.view, "failure");
  assert.equal(parsed.diagnostics.failure.category, "provider");
  assert.equal(
    parsed.diagnostics.failure.headline,
    "Provider bootstrap timed out.",
  );
  assert.equal(eventQueries.length, 3);
  assert.equal(eventQueries[0]?.after, 0);
  assert.equal(eventQueries[1]?.after, 3);
  assert.equal(eventQueries[2]?.after, 6);
  assert.equal(
    parsed.diagnostics.timeline.entries.at(-1)?.eventType,
    "run_failed",
  );
});

test("run list pages by work item identifier when the runtime work item id filter does not match", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await invokeCli(
    ["run", "list", "--work-item", "ORQ-48", "--limit", "2"],
    {
      loadConfig: async () => ({}) as LoadedConfig,
      createRuntimeClient: () => ({
        createRun: async () => {
          throw new Error("unused");
        },
        getRun: async () => {
          throw new Error("unused");
        },
        listRuns: async (query) => {
          calls.push(query ?? {});
          if (query?.workItemId === "ORQ-48") {
            return { runs: [], nextCursor: null };
          }

          if (query?.cursor === undefined) {
            return {
              runs: [
                createRun({ runId: "run-001", workItemIdentifier: "ORQ-01" }),
                createRun({ runId: "run-002", workItemIdentifier: "ORQ-02" }),
              ],
              nextCursor: "page-2",
            };
          }

          return {
            runs: [
              createRun({ runId: "run-048", workItemIdentifier: "ORQ-48" }),
              createRun({ runId: "run-049", workItemIdentifier: "ORQ-48" }),
            ],
            nextCursor: null,
          };
        },
        listRunEvents: async () => {
          throw new Error("unused");
        },
        getHealth: async () => {
          throw new Error("unused");
        },
      }),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /run-048 \| ORQ-48/);
  assert.match(result.stdout, /run-049 \| ORQ-48/);
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.workItemId, "ORQ-48");
  assert.equal(calls[1]?.cursor, undefined);
  assert.equal(calls[2]?.cursor, "page-2");
});

test("run command works against an in-process runtime API server", async (t) => {
  const fixture = createRuntimeFixture(t);
  const supervisor = new FakeSessionSupervisor();
  const daemon = new RuntimeDaemon(fixture.runtimeConfig, {
    adapterRegistry: new RuntimeAdapterRegistry(),
    sessionSupervisor: supervisor,
    dispatcherIntervalMs: 5,
  });
  daemon.registerRuntimeAdapter("codex", () => new FakeProviderAdapter());
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

  daemon.enqueueRun(
    createRunInput({
      runId: "run-live-001",
      workItemId: "issue-live",
      workItemIdentifier: "ORQ-48",
    }),
  );

  const endpoint = new URL(apiServer.info.endpoint);
  const client = new HttpRuntimeApiClient({
    listenOptions: {
      kind: "tcp",
      host: endpoint.hostname,
      port: Number(endpoint.port),
    },
  });

  const result = await invokeCli(
    ["run", "inspect", "run-live-001", "--view", "overview"],
    {
      loadConfig: async () => ({}) as LoadedConfig,
      createRuntimeClient: () => client,
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^Overview$/m);
  assert.match(result.stdout, /Run ID: run-live-001/);
  assert.match(result.stdout, /Work Item: ORQ-48/);
});

function createRun(overrides: Partial<RuntimeApiRun> = {}): RuntimeApiRun {
  return {
    runId: "run-001",
    workItemId: "issue-48",
    workItemIdentifier: "ORQ-48",
    phase: "implement",
    provider: "codex",
    status: "running",
    repoRoot: "/repo",
    workspace: {
      mode: "ephemeral_worktree",
      assignedBranch: "hillkimball/orq-48",
      pullRequestUrl: "https://github.com/kimballh/orqestrate/pull/48",
      writeScope: "repo",
    },
    artifactUrl: "https://www.notion.so/orq-48",
    requestedBy: "Kimball Hill",
    grantedCapabilities: ["github.read_pr"],
    promptContractId: "orqestrate/implement/v1",
    promptDigests: {
      system: "sha256-system",
      user: "sha256-user",
    },
    promptProvenance: {
      selection: {
        promptPackName: "default",
        capabilityNames: ["github.read_pr"],
        organizationOverlayNames: ["reviewer_qa"],
        projectOverlayNames: ["reviewer_webapp"],
        experimentName: "reviewer_v2",
      },
      sources: [
        {
          kind: "base_pack",
          ref: "prompt-pack:default/base/system.md",
          digest: "sha256:base-pack",
        },
      ],
      rendered: {
        systemPromptLength: 412,
        userPromptLength: 1867,
        attachmentKinds: ["artifact_url"],
        attachmentCount: 1,
      },
    },
    limits: {
      maxWallTimeSec: 5400,
      idleTimeoutSec: 900,
      bootstrapTimeoutSec: 120,
    },
    outcome: null,
    createdAt: "2026-04-15T18:00:00.000Z",
    admittedAt: "2026-04-15T18:01:00.000Z",
    startedAt: "2026-04-15T18:02:00.000Z",
    readyAt: "2026-04-15T18:03:00.000Z",
    completedAt: null,
    lastHeartbeatAt: "2026-04-15T18:04:30.000Z",
    priority: 3,
    runtimeOwner: "runtime-1",
    attemptCount: 1,
    waitingHumanReason: null,
    version: 1,
    lastEventSeq: 1,
    ...overrides,
  };
}

async function invokeCli(
  args: string[],
  overrides: {
    loadConfig: () => Promise<LoadedConfig>;
    createRuntimeClient: () => RuntimeClient;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(args, {
    cwd: () => process.cwd(),
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
    loadConfig: overrides.loadConfig,
    createRuntimeClient: overrides.createRuntimeClient,
  });

  return {
    exitCode,
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
  };
}
