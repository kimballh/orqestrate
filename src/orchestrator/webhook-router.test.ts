import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openWakeupDatabase } from "./wakeup-database.js";
import { WakeupRepository } from "./wakeup-repository.js";
import { WebhookRouter } from "./webhook-router.js";

test("webhook router accepts signed Linear deliveries and persists a wakeup row", async (t) => {
  const fixture = createFixture(t);
  const database = openWakeupDatabase(fixture.databasePath);
  t.after(() => database.close());
  const repository = new WakeupRepository(database.connection);
  const router = new WebhookRouter({
    repository,
    linearSigningSecret: "linear-secret",
    now: () => new Date("2026-04-15T00:00:00.000Z"),
  });
  const server = http.createServer((request, response) => {
    void router.handle(request, response);
  });
  await listen(server);
  t.after(async () => {
    await closeServer(server);
  });

  const payload = {
    action: "update",
    type: "Issue",
    data: {
      id: "issue-1",
    },
    webhookTimestamp: Date.parse("2026-04-15T00:00:00.000Z"),
  };

  const response = await postJson(server, "/v1/webhooks/linear", payload, {
    "linear-delivery": "delivery-1",
    "linear-event": "Issue",
    "linear-signature": signPayload("linear-secret", payload),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(repository.list("queued").length, 1);
  assert.equal(repository.list("queued")[0]?.issueId, "issue-1");
});

test("webhook router rejects invalid signatures without enqueuing work", async (t) => {
  const fixture = createFixture(t);
  const database = openWakeupDatabase(fixture.databasePath);
  t.after(() => database.close());
  const repository = new WakeupRepository(database.connection);
  const router = new WebhookRouter({
    repository,
    linearSigningSecret: "linear-secret",
    now: () => new Date("2026-04-15T00:00:00.000Z"),
  });
  const server = http.createServer((request, response) => {
    void router.handle(request, response);
  });
  await listen(server);
  t.after(async () => {
    await closeServer(server);
  });

  const payload = {
    action: "update",
    type: "Issue",
    data: {
      id: "issue-1",
    },
    webhookTimestamp: Date.parse("2026-04-15T00:00:00.000Z"),
  };

  const response = await postJson(server, "/v1/webhooks/linear", payload, {
    "linear-delivery": "delivery-1",
    "linear-event": "Issue",
    "linear-signature": "deadbeef",
  });

  assert.equal(response.statusCode, 401);
  assert.equal(repository.list().length, 0);
});

function createFixture(t: { after(callback: () => void): void }) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "orq-webhook-router-"));
  t.after(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  return {
    databasePath: path.join(rootDir, "orchestrator.sqlite"),
  };
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function postJson(
  server: http.Server,
  pathname: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ statusCode: number; body: string }> {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Server is not listening.");
  }

  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        method: "POST",
        host: address.address,
        port: address.port,
        path: pathname,
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 500,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

function signPayload(secret: string, payload: unknown): string {
  const rawBody = JSON.stringify(payload);
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}
