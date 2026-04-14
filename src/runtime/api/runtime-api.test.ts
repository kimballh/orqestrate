import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { RuntimeDaemon } from "../daemon.js";
import { RuntimeApiServer } from "./server.js";
import {
  createRunInput,
  createRuntimeFixture,
  FakeProviderAdapter,
  FakeSessionSupervisor,
  waitForAsyncTurn,
  waitForRunStatus,
} from "../test-support.js";

test("runtime API exposes runs, pagination, health, capacity, and event replay", async (t) => {
  const { daemon, apiServer, supervisor } = await createApiFixture(t, {
    maxConcurrentRuns: 1,
    maxRunsPerProvider: 1,
  });

  const firstCreate = await postJson(apiServer.info.endpoint, "/v1/runs", createRunInput({
    runId: "run-001",
    workItemId: "issue-1",
  }));
  const secondCreate = await postJson(apiServer.info.endpoint, "/v1/runs", createRunInput({
    runId: "run-002",
    workItemId: "issue-2",
  }));

  assert.equal(firstCreate.status, 201);
  assert.equal(firstCreate.body.created, true);
  assert.equal(secondCreate.status, 201);

  await waitForAsyncTurn();

  const health = await getJson(apiServer.info.endpoint, "/v1/health");
  assert.equal(health.body.ok, true);

  const capacity = await getJson(apiServer.info.endpoint, "/v1/capacity");
  assert.equal(capacity.body.global.active, 1);
  assert.equal(capacity.body.global.queued, 1);

  const firstPage = await getJson(apiServer.info.endpoint, "/v1/runs?limit=1");
  assert.equal(firstPage.body.runs.length, 1);
  assert.equal(typeof firstPage.body.nextCursor, "string");

  const secondPage = await getJson(
    apiServer.info.endpoint,
    `/v1/runs?limit=1&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`,
  );
  assert.equal(secondPage.body.runs.length, 1);
  assert.equal(secondPage.body.nextCursor, null);

  const run = await getJson(apiServer.info.endpoint, "/v1/runs/run-001");
  assert.equal(run.body.run.runId, "run-001");
  assert.equal(typeof run.body.run.lastEventSeq, "number");

  const events = await getJson(apiServer.info.endpoint, "/v1/runs/run-001/events?after=0");
  const eventTypes = events.body.events.map((event: { eventType: string }) => event.eventType);
  assert.ok(eventTypes.includes("run_enqueued"));
  assert.ok(eventTypes.includes("run_admitted"));

  supervisor.emitOutput("session-1", "READY\n");
  supervisor.emitExit("session-1", 0, null);
  await waitForRunStatus(daemon, "run-002", "bootstrapping");
  supervisor.emitOutput("session-2", "READY\n");
  supervisor.emitExit("session-2", 0, null);
  await waitForRunStatus(daemon, "run-002", "completed");
});

test("runtime API streams events, resumes from Last-Event-ID, and supports human input plus cancel", async (t) => {
  const { daemon, apiServer, supervisor } = await createApiFixture(t);

  await postJson(apiServer.info.endpoint, "/v1/runs", createRunInput({
    runId: "run-001",
    workItemId: "issue-1",
  }));

  await waitForRunStatus(daemon, "run-001", "bootstrapping");

  const streamResponse = await fetch(`${apiServer.info.endpoint}/v1/runs/run-001/stream`);
  assert.equal(streamResponse.status, 200);
  const reader = streamResponse.body?.getReader();
  assert.ok(reader);

  supervisor.emitOutput("session-1", "READY\n");
  const firstChunk = await readUntil(
    reader,
    (text) => text.includes("event: session_ready"),
  );
  const sessionReadyId = extractLastEventId(firstChunk);
  assert.ok(sessionReadyId !== null);
  await reader.cancel();

  const resumedStream = await fetch(`${apiServer.info.endpoint}/v1/runs/run-001/stream`, {
    headers: {
      "Last-Event-ID": String(sessionReadyId),
    },
  });
  assert.equal(resumedStream.status, 200);
  const resumedReader = resumedStream.body?.getReader();
  assert.ok(resumedReader);

  supervisor.emitOutput("session-1", "NEEDS_HUMAN\n");
  const waitingChunk = await readUntil(
    resumedReader,
    (text) => text.includes("event: waiting_human"),
  );
  assert.match(waitingChunk, /event: waiting_human/);

  const humanInput = await postJson(
    apiServer.info.endpoint,
    "/v1/runs/run-001/actions/human-input",
    {
      kind: "answer",
      message: "Proceed with the current plan.",
      author: "Kimball Hill",
    },
  );
  assert.equal(humanInput.status, 202);
  assert.equal(humanInput.body.accepted, true);
  assert.equal(humanInput.body.run.status, "running");

  const cancel = await postJson(
    apiServer.info.endpoint,
    "/v1/runs/run-001/actions/cancel",
    {
      reason: "Operator canceled the run.",
      requestedBy: "Kimball Hill",
    },
  );
  assert.equal(cancel.status, 202);
  assert.equal(cancel.body.accepted, true);

  const canceledChunk = await readUntil(
    resumedReader,
    (text) => text.includes("event: run_canceled"),
  );
  assert.match(canceledChunk, /event: run_canceled/);
  await resumedReader.cancel();
});

async function createApiFixture(
  t: TestContext,
  policyOverrides: Partial<RuntimeDaemon["runtimeConfig"]["policy"]> = {},
): Promise<{
  daemon: RuntimeDaemon;
  apiServer: RuntimeApiServer;
  supervisor: FakeSessionSupervisor;
}> {
  const fixture = createRuntimeFixture(t as never);
  Object.assign(fixture.runtimeConfig.policy, policyOverrides);

  const supervisor = new FakeSessionSupervisor();
  const daemon = new RuntimeDaemon(fixture.runtimeConfig, {
    sessionSupervisor: supervisor,
    dispatcherIntervalMs: 5,
  });
  daemon.registerRuntimeAdapter("codex", () => new FakeProviderAdapter());
  daemon.start();
  t.after(() => daemon.stop());

  const apiServer = new RuntimeApiServer(daemon, {
    kind: "tcp",
    host: "127.0.0.1",
    port: 0,
  });
  await apiServer.start();
  t.after(async () => {
    await apiServer.stop();
  });

  return {
    daemon,
    apiServer,
    supervisor,
  };
}

async function getJson(baseUrl: string, pathname: string) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return {
    status: response.status,
    body: (await response.json()) as any,
  };
}

async function postJson(baseUrl: string, pathname: string, body: unknown) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: (await response.json()) as any,
  };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const chunk = await reader.read();

    if (chunk.done) {
      break;
    }

    text += decoder.decode(chunk.value, { stream: true });
    if (predicate(text)) {
      return text;
    }
  }

  assert.fail("Timed out waiting for streamed runtime events.");
}

function extractLastEventId(text: string): number | null {
  const matches = [...text.matchAll(/id: (\d+)/g)];
  const lastMatch = matches.at(-1);

  if (lastMatch === undefined) {
    return null;
  }

  return Number.parseInt(lastMatch[1], 10);
}
