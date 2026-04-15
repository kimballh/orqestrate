import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http, { type IncomingMessage } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { RuntimeDaemon } from "../daemon.js";
import { RuntimeAdapterRegistry } from "../runtime-adapter-registry.js";
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
  const { daemon, apiServer, supervisor, cleanup } = await createApiFixture({
    maxConcurrentRuns: 1,
    maxRunsPerProvider: 1,
  });
  try {
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
    assert.equal(
      firstCreate.body.run.promptProvenance.selection.promptPackName,
      "default",
    );
    assert.equal(
      firstCreate.body.run.promptProvenance.sources[0]?.digest,
      "sha256-base-pack",
    );

    await waitForAsyncTurn();

    const health = await getJson(apiServer.info.endpoint, "/v1/health");
    assert.equal(health.body.ok, true);

    const capacity = await getJson(apiServer.info.endpoint, "/v1/capacity");
    assert.equal(capacity.body.global.active, 1);
    assert.equal(capacity.body.global.queued, 1);

    const firstPage = await getJson(apiServer.info.endpoint, "/v1/runs?limit=1");
    assert.equal(firstPage.body.runs.length, 1);
    assert.equal(typeof firstPage.body.nextCursor, "string");
    assert.equal(
      firstPage.body.runs[0]?.promptProvenance.selection.promptPackName,
      "default",
    );

    const secondPage = await getJson(
      apiServer.info.endpoint,
      `/v1/runs?limit=1&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`,
    );
    assert.equal(secondPage.body.runs.length, 1);
    assert.equal(secondPage.body.nextCursor, null);

    const run = await getJson(apiServer.info.endpoint, "/v1/runs/run-001");
    assert.equal(run.body.run.runId, "run-001");
    assert.equal(typeof run.body.run.lastEventSeq, "number");
    assert.deepEqual(run.body.run.promptProvenance.rendered.attachmentKinds, []);

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
  } finally {
    await cleanup();
  }
});

test("runtime API streams events, resumes from Last-Event-ID, and supports human input plus cancel", async (t) => {
  const { daemon, apiServer, supervisor, cleanup } = await createApiFixture();
  try {
    await postJson(apiServer.info.endpoint, "/v1/runs", createRunInput({
      runId: "run-001",
      workItemId: "issue-1",
    }));

    await waitForRunStatus(daemon, "run-001", "bootstrapping");

    const stream = await openStream(apiServer.info.endpoint, "/v1/runs/run-001/stream");
    assert.equal(stream.status, 200);

    supervisor.emitOutput("session-1", "READY\n");
    const firstChunk = await readUntil(
      stream.response,
      (text) => text.includes("event: session_ready"),
    );
    const sessionReadyId = extractLastEventId(firstChunk);
    assert.ok(sessionReadyId !== null);
    stream.close();

    const resumedStream = await openStream(apiServer.info.endpoint, "/v1/runs/run-001/stream", {
      "Last-Event-ID": String(sessionReadyId),
    });
    assert.equal(resumedStream.status, 200);

    supervisor.emitOutput("session-1", "NEEDS_HUMAN\n");
    const waitingChunk = await readUntil(
      resumedStream.response,
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
      resumedStream.response,
      (text) => text.includes("event: run_canceled"),
    );
    assert.match(canceledChunk, /event: run_canceled/);
    resumedStream.close();
  } finally {
    await cleanup();
  }
});

test("runtime API server does not unlink a live Unix socket when a second server starts", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix socket semantics are not available on Windows.");
  }

  const fixture = createRuntimeFixture(t);
  const socketPath = path.join(fixture.runtimeConfig.stateDir, "runtime.sock");

  const firstDaemon = new RuntimeDaemon(fixture.runtimeConfig, {
    adapterRegistry: new RuntimeAdapterRegistry(),
    sessionSupervisor: new FakeSessionSupervisor(),
    dispatcherIntervalMs: 5,
  });
  firstDaemon.registerRuntimeAdapter("codex", () => new FakeProviderAdapter());
  firstDaemon.start();
  const firstServer = new RuntimeApiServer(firstDaemon, {
    kind: "socket",
    socketPath,
  });
  await firstServer.start();
  const secondDaemon = new RuntimeDaemon(fixture.runtimeConfig, {
    adapterRegistry: new RuntimeAdapterRegistry(),
    sessionSupervisor: new FakeSessionSupervisor(),
    dispatcherIntervalMs: 5,
  });
  secondDaemon.registerRuntimeAdapter("codex", () => new FakeProviderAdapter());
  secondDaemon.start();
  const secondServer = new RuntimeApiServer(secondDaemon, {
    kind: "socket",
    socketPath,
  });
  try {
    await assert.rejects(() => secondServer.start(), /already in use/);
    assert.equal(existsSync(socketPath), true);

    const rawResponse = await requestUnixSocket(socketPath, "/v1/health");
    assert.match(rawResponse, /HTTP\/1.1 200 OK/);
  } finally {
    await firstServer.stop();
    await firstDaemon.stop();
    await secondDaemon.stop();
  }
});

test("interrupt action reports accepted false when no live session exists", async (t) => {
  const { apiServer, cleanup } = await createApiFixture({
    maxConcurrentRuns: 0,
  });
  try {
    await postJson(apiServer.info.endpoint, "/v1/runs", createRunInput({
      runId: "run-queued",
      workItemId: "issue-queued",
    }));

    const interrupt = await postJson(
      apiServer.info.endpoint,
      "/v1/runs/run-queued/actions/interrupt",
      {},
    );

    assert.equal(interrupt.status, 202);
    assert.equal(interrupt.body.accepted, false);

    const events = await getJson(apiServer.info.endpoint, "/v1/runs/run-queued/events?after=0");
    const eventTypes = events.body.events.map((event: { eventType: string }) => event.eventType);
    assert.deepEqual(eventTypes, ["run_enqueued"]);
  } finally {
    await cleanup();
  }
});

async function createApiFixture(
  policyOverrides: Partial<RuntimeDaemon["runtimeConfig"]["policy"]> = {},
): Promise<{
  daemon: RuntimeDaemon;
  apiServer: RuntimeApiServer;
  supervisor: FakeSessionSupervisor;
  cleanup: () => Promise<void>;
}> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "orq-runtime-api-"));
  const fixture = {
    rootDir,
    runtimeConfig: {
      sourcePath: path.join(rootDir, "config.toml"),
      profileName: "test",
      stateDir: path.join(rootDir, "state"),
      logDir: path.join(rootDir, "logs"),
      runtimeLogDir: path.join(rootDir, "logs", "runtime"),
      databasePath: path.join(rootDir, "state", "runtime.sqlite"),
      policy: {
        maxConcurrentRuns: 4,
        maxRunsPerProvider: 2,
        allowMixedProviders: true,
        defaultPhaseTimeoutSec: 5400,
      },
    },
  };
  Object.assign(fixture.runtimeConfig.policy, policyOverrides);

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

  return {
    daemon,
    apiServer,
    supervisor,
    cleanup: async () => {
      if (apiServer.isListening) {
        await apiServer.stop();
      }
      await daemon.stop();
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

async function getJson(baseUrl: string, pathname: string) {
  const response = await sendHttpRequest(baseUrl, pathname, {
    method: "GET",
  });
  return {
    status: response.status,
    body: response.body,
  };
}

async function postJson(baseUrl: string, pathname: string, body: unknown) {
  const response = await sendHttpRequest(baseUrl, pathname, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: response.body,
  };
}

async function readUntil(
  response: IncomingMessage,
  predicate: (text: string) => boolean,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    let text = "";

    const cleanup = () => {
      response.off("data", onData);
      response.off("error", onError);
      response.off("close", onClose);
      response.off("end", onClose);
    };
    const onData = (chunk: Buffer | string) => {
      text += chunk.toString();
      if (predicate(text)) {
        cleanup();
        resolve(text);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Timed out waiting for streamed runtime events."));
    };

    response.on("data", onData);
    response.once("error", onError);
    response.once("close", onClose);
    response.once("end", onClose);
  });
}

function extractLastEventId(text: string): number | null {
  const matches = [...text.matchAll(/id: (\d+)/g)];
  const lastMatch = matches.at(-1);

  if (lastMatch === undefined) {
    return null;
  }

  return Number.parseInt(lastMatch[1], 10);
}

async function requestUnixSocket(
  socketPath: string,
  pathname: string,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = "";

    socket.once("connect", () => {
      socket.write(
        `GET ${pathname} HTTP/1.1\r\nHost: runtime.local\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.once("end", () => {
      resolve(response);
    });
    socket.once("error", reject);
  });
}

async function sendHttpRequest(
  baseUrl: string,
  pathname: string,
  input: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; body: any }> {
  const url = new URL(pathname, baseUrl);

  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: input.method,
        headers: {
          connection: "close",
          ...(input.headers ?? {}),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: text.length === 0 ? null : JSON.parse(text),
          });
        });
      },
    );

    request.once("error", reject);
    if (input.body !== undefined) {
      request.write(input.body);
    }
    request.end();
  });
}

async function openStream(
  baseUrl: string,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  response: IncomingMessage;
  close: () => void;
}> {
  const url = new URL(pathname, baseUrl);

  return await new Promise((resolve, reject) => {
    const request = http.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        connection: "close",
        accept: "text/event-stream",
        ...headers,
      },
    });

    request.once("response", (response) => {
      resolve({
        status: response.statusCode ?? 0,
        response,
        close: () => {
          response.destroy();
          request.destroy();
        },
      });
    });
    request.once("error", reject);
    request.end();
  });
}
