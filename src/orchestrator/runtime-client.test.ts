import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeDaemon } from "../runtime/daemon.js";
import { RuntimeAdapterRegistry } from "../runtime/runtime-adapter-registry.js";
import { RuntimeApiServer } from "../runtime/api/server.js";
import {
  createRunInput,
  createRuntimeFixture,
  FakeProviderAdapter,
  FakeSessionSupervisor,
} from "../runtime/test-support.js";

import { HttpRuntimeApiClient } from "./runtime-client.js";

test("HttpRuntimeApiClient creates runs and replays events over the public runtime API", async (t) => {
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

  const endpoint = new URL(apiServer.info.endpoint);
  const client = new HttpRuntimeApiClient({
    listenOptions: {
      kind: "tcp",
      host: endpoint.hostname,
      port: Number(endpoint.port),
    },
  });

  const created = await client.createRun(
    createRunInput({
      runId: "run-client-001",
      workItemId: "issue-client-001",
      workItemIdentifier: "ORQ-38",
    }),
  );
  assert.equal(created.created, true);
  assert.equal(created.run.runId, "run-client-001");

  const fetched = await client.getRun("run-client-001");
  assert.equal(fetched.runId, "run-client-001");
  assert.ok(["queued", "admitted", "launching", "bootstrapping"].includes(fetched.status));

  const events = await client.listRunEvents("run-client-001", {
    after: 0,
    waitMs: 0,
  });
  assert.ok(events.some((event) => event.eventType === "run_enqueued"));
});
