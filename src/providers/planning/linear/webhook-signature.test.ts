import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { verifyLinearWebhook } from "./webhook-signature.js";

test("verifyLinearWebhook accepts valid signatures within the replay window", () => {
  const rawBody = Buffer.from(
    JSON.stringify({
      action: "update",
      type: "Issue",
      data: { id: "issue-1" },
      webhookTimestamp: Date.parse("2026-04-15T00:00:00.000Z"),
    }),
    "utf8",
  );
  const secret = "linear-secret";
  const signature = createHmac("sha256", secret).update(rawBody).digest("hex");

  const result = verifyLinearWebhook({
    rawBody,
    signature,
    signingSecret: secret,
    webhookTimestamp: Date.parse("2026-04-15T00:00:00.000Z"),
    now: () => new Date("2026-04-15T00:00:30.000Z"),
  });

  assert.deepEqual(result, { ok: true });
});

test("verifyLinearWebhook rejects invalid signatures and stale timestamps", () => {
  const rawBody = Buffer.from("{\"ok\":true}", "utf8");

  const invalidSignature = verifyLinearWebhook({
    rawBody,
    signature: "deadbeef",
    signingSecret: "linear-secret",
    webhookTimestamp: Date.parse("2026-04-15T00:00:00.000Z"),
    now: () => new Date("2026-04-15T00:00:00.000Z"),
  });
  assert.equal(invalidSignature.ok, false);
  assert.equal(invalidSignature.reason, "invalid_signature");

  const signature = createHmac("sha256", "linear-secret")
    .update(rawBody)
    .digest("hex");
  const stale = verifyLinearWebhook({
    rawBody,
    signature,
    signingSecret: "linear-secret",
    webhookTimestamp: Date.parse("2026-04-15T00:00:00.000Z"),
    now: () => new Date("2026-04-15T00:02:00.000Z"),
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "stale_timestamp");
});
