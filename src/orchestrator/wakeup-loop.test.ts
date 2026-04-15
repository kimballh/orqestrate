import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openWakeupDatabase } from "./wakeup-database.js";
import { WakeupLoop } from "./wakeup-loop.js";
import { WakeupRepository } from "./wakeup-repository.js";
import type { WakeupEventRecord } from "./wakeup-types.js";

test("wakeup loop marks successfully processed rows done", async (t) => {
  const repository = createRepository(t);
  repository.enqueue(createWakeupInput());

  const processed: string[] = [];
  const loop = new WakeupLoop({
    repository,
    owner: "orchestrator:test",
    now: () => new Date("2026-04-15T00:00:10.000Z"),
    processor: {
      async process(event) {
        processed.push(event.eventId);
        return {
          eventId: event.eventId,
          outcome: "executed",
          summary: "done",
        };
      },
    },
  });

  const results = await loop.runOnce();

  assert.equal(results.length, 1);
  assert.deepEqual(processed, ["event-1"]);
  assert.equal(repository.get("event-1")?.status, "done");
});

test("wakeup loop requeues transient failures and dead-letters after the max attempts", async (t) => {
  const repository = createRepository(t);
  repository.enqueue(createWakeupInput());

  let currentTime = new Date("2026-04-15T00:00:10.000Z");
  const loop = new WakeupLoop({
    repository,
    owner: "orchestrator:test",
    maxAttempts: 2,
    now: () => currentTime,
    processor: {
      async process(_event: WakeupEventRecord) {
        throw new Error("temporary failure");
      },
    },
  });

  await loop.runOnce();

  const firstAttempt = repository.get("event-1");
  assert.equal(firstAttempt?.status, "queued");
  assert.equal(firstAttempt?.attempts, 1);
  assert.equal(firstAttempt?.lastError, "temporary failure");

  currentTime = new Date(firstAttempt?.availableAt ?? "2026-04-15T00:00:11.000Z");
  await loop.runOnce();

  const secondAttempt = repository.get("event-1");
  assert.equal(secondAttempt?.status, "dead_letter");
  assert.equal(secondAttempt?.attempts, 2);
  assert.equal(secondAttempt?.lastError, "temporary failure");
});

function createRepository(t: { after(callback: () => void): void }) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "orq-wakeup-loop-"));
  t.after(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  const database = openWakeupDatabase(path.join(rootDir, "orchestrator.sqlite"));
  t.after(() => {
    database.close();
  });

  return new WakeupRepository(database.connection);
}

function createWakeupInput() {
  return {
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
  };
}
