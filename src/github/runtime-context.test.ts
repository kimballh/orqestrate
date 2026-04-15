import assert from "node:assert/strict";
import test from "node:test";

import { parseRuntimeApiEndpoint, loadGitHubRuntimeRun } from "./runtime-context.js";

test("parseRuntimeApiEndpoint supports unix sockets and tcp endpoints", () => {
  assert.deepEqual(
    parseRuntimeApiEndpoint("unix:///tmp/orq/runtime.sock"),
    {
      kind: "socket",
      socketPath: "/tmp/orq/runtime.sock",
    },
  );
  assert.deepEqual(
    parseRuntimeApiEndpoint("http://127.0.0.1:4100"),
    {
      kind: "tcp",
      host: "127.0.0.1",
      port: 4100,
    },
  );
});

test("loadGitHubRuntimeRun requires run and endpoint env", async () => {
  await assert.rejects(
    () => loadGitHubRuntimeRun({}),
    /ORQ_RUN_ID/,
  );

  await assert.rejects(
    () =>
      loadGitHubRuntimeRun({
        ORQ_RUN_ID: "run-001",
      }),
    /ORQ_RUNTIME_API_ENDPOINT/,
  );
});

test("loadGitHubRuntimeRun resolves the active run through the runtime endpoint", async () => {
  const run = await loadGitHubRuntimeRun(
    {
      ORQ_RUN_ID: "run-123",
      ORQ_RUNTIME_API_ENDPOINT: "unix:///tmp/orq/runtime.sock",
    },
    {
      getRun: async (runId, listenOptions) => {
        assert.equal(runId, "run-123");
        assert.deepEqual(listenOptions, {
          kind: "socket",
          socketPath: "/tmp/orq/runtime.sock",
        });
        return {
          runId,
          workspace: {
            repoRoot: "/repo",
            mode: "ephemeral_worktree",
          },
        } as never;
      },
    },
  );

  assert.equal(run.runId, "run-123");
});
