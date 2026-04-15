import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import { openWakeupDatabase } from "./wakeup-database.js";
import { WakeupRepository } from "./wakeup-repository.js";
import {
  getWakeupSchemaVersion,
  WAKEUP_SCHEMA_VERSION,
} from "./wakeup-migrations.js";

test("wakeup repository initializes the canonical schema and WAL mode", (t) => {
  const fixture = createWakeupFixture(t);
  const database = openWakeupDatabase(fixture.databasePath);
  t.after(() => database.close());

  assert.equal(
    getWakeupSchemaVersion(database.connection),
    WAKEUP_SCHEMA_VERSION,
  );
  assert.equal(
    database.connection.pragma("journal_mode", { simple: true }),
    "wal",
  );
});

test("enqueue coalesces repeated queued wakeups for the same issue", (t) => {
  const repository = createRepository(t);

  const first = repository.enqueue({
    eventId: "event-1",
    provider: "linear",
    deliveryId: "delivery-1",
    resourceType: "Issue",
    resourceId: "issue-1",
    issueId: "issue-1",
    action: "update",
    dedupeKey: "linear:Issue:issue-1",
    receivedAt: "2026-04-15T00:00:00.000Z",
    payloadJson: "{\"id\":\"issue-1\"}",
  });
  const second = repository.enqueue({
    eventId: "event-2",
    provider: "linear",
    deliveryId: "delivery-2",
    resourceType: "Issue",
    resourceId: "issue-1",
    issueId: "issue-1",
    action: "update",
    dedupeKey: "linear:Issue:issue-1",
    receivedAt: "2026-04-15T00:00:03.000Z",
    payloadJson: "{\"id\":\"issue-1\",\"updated\":true}",
  });

  assert.equal(first.kind, "inserted");
  assert.equal(second.kind, "coalesced");
  assert.equal(second.event.eventId, "event-1");
  assert.equal(second.event.deliveryId, "delivery-2");
  assert.equal(second.event.lastReceivedAt, "2026-04-15T00:00:03.000Z");
  assert.equal(second.event.coalescedCount, 1);
  assert.equal(repository.list("queued").length, 1);
});

test("claiming increments attempts and supports requeue plus dead-letter transitions", (t) => {
  const repository = createRepository(t);

  repository.enqueue({
    eventId: "event-1",
    provider: "linear",
    deliveryId: "delivery-1",
    resourceType: "Issue",
    resourceId: "issue-1",
    issueId: "issue-1",
    action: "update",
    dedupeKey: "linear:Issue:issue-1",
    receivedAt: "2026-04-15T00:00:00.000Z",
    payloadJson: null,
  });

  const claimed = repository.claimNext(
    "orchestrator:test",
    "2026-04-15T00:00:05.000Z",
  );
  assert.ok(claimed);
  assert.equal(claimed.status, "processing");
  assert.equal(claimed.attempts, 1);

  const requeued = repository.requeue({
    eventId: claimed.eventId,
    availableAt: "2026-04-15T00:00:10.000Z",
    lastError: "temporary failure",
  });
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.availableAt, "2026-04-15T00:00:10.000Z");
  assert.equal(requeued.lastError, "temporary failure");

  const claimedAgain = repository.claimNext(
    "orchestrator:test",
    "2026-04-15T00:00:10.000Z",
  );
  assert.ok(claimedAgain);
  assert.equal(claimedAgain.attempts, 2);

  const deadLetter = repository.markDeadLetter(
    claimedAgain.eventId,
    "permanent failure",
    "2026-04-15T00:00:11.000Z",
  );
  assert.equal(deadLetter.status, "dead_letter");
  assert.equal(deadLetter.lastError, "permanent failure");
  assert.equal(deadLetter.processedAt, "2026-04-15T00:00:11.000Z");
});

function createRepository(t: TestContext): WakeupRepository {
  const fixture = createWakeupFixture(t);
  const database = openWakeupDatabase(fixture.databasePath);
  t.after(() => database.close());
  return new WakeupRepository(database.connection);
}

function createWakeupFixture(t: { after(callback: () => void): void }) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "orq-wakeup-"));
  t.after(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  return {
    rootDir,
    databasePath: path.join(rootDir, "orchestrator.sqlite"),
  };
}
