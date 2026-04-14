import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_LINEAR_DESCRIPTION_MACHINE_STATE,
  parseLinearDescriptionMachineState,
  upsertLinearDescriptionMachineState,
} from "./index.js";

test("parses missing machine-state blocks as safe defaults", () => {
  const parsed = parseLinearDescriptionMachineState(
    "Human-authored ticket body only.",
  );

  assert.equal(parsed.description, "Human-authored ticket body only.");
  assert.equal(parsed.hasMachineStateBlock, false);
  assert.deepEqual(parsed.machineState, EMPTY_LINEAR_DESCRIPTION_MACHINE_STATE);
});

test("round-trips machine-state blocks while preserving surrounding text", () => {
  const original = [
    "# Context",
    "Human-authored summary.",
    "",
    "## Notes",
    "Keep this text exactly as written.",
  ].join("\n");

  const initial = upsertLinearDescriptionMachineState(original, {
    owner: "worker-1",
    runId: "run-53",
    leaseUntil: "2026-04-14T22:00:00.000Z",
    artifactUrl: "https://notion.so/orq-53",
    blockedReason: null,
    lastError: null,
    attemptCount: 1,
  });
  const updated = upsertLinearDescriptionMachineState(initial, {
    owner: null,
    runId: null,
    leaseUntil: null,
    artifactUrl: "https://notion.so/orq-53-v2",
    blockedReason: "Waiting on a human decision.",
    lastError: {
      providerFamily: "planning",
      providerKind: "planning.linear",
      code: "validation",
      message: "Machine-state validation failed.",
      retryable: false,
      details: { reason: "duplicate_labels" },
    },
    attemptCount: 2,
  });

  const parsed = parseLinearDescriptionMachineState(updated);

  assert.equal(parsed.description, original);
  assert.equal(parsed.machineState.owner, null);
  assert.equal(parsed.machineState.artifactUrl, "https://notion.so/orq-53-v2");
  assert.equal(parsed.machineState.blockedReason, "Waiting on a human decision.");
  assert.equal(parsed.machineState.lastError?.message, "Machine-state validation failed.");
  assert.equal(parsed.machineState.attemptCount, 2);
});

test("preserves leading and trailing human-authored whitespace exactly", () => {
  const original = "\n\n# Title\nBody\n\n";

  const withBlock = upsertLinearDescriptionMachineState(original, {
    owner: null,
    runId: null,
    leaseUntil: null,
    artifactUrl: null,
    blockedReason: null,
    lastError: null,
    attemptCount: 0,
  });

  const parsed = parseLinearDescriptionMachineState(withBlock);
  const rewritten = upsertLinearDescriptionMachineState(withBlock, {
    owner: "worker-1",
    runId: "run-1",
    leaseUntil: "2026-04-15T00:00:00.000Z",
    artifactUrl: null,
    blockedReason: null,
    lastError: null,
    attemptCount: 1,
  });

  assert.equal(parsed.description, original);
  assert.match(rewritten, /Body\n\n<!-- orqestrate:machine-state:boundary -->/);
});

test("moves the machine-state block back to the end when humans append notes after it", () => {
  const withBlock = upsertLinearDescriptionMachineState("Body", {
    owner: null,
    runId: null,
    leaseUntil: null,
    artifactUrl: null,
    blockedReason: null,
    lastError: null,
    attemptCount: 0,
  });
  const withTrailingNotes = `${withBlock}\n\nPostscript from a human.`;

  const rewritten = upsertLinearDescriptionMachineState(withTrailingNotes, {
    owner: "worker-1",
    runId: "run-2",
    leaseUntil: "2026-04-15T00:00:00.000Z",
    artifactUrl: "https://notion.so/orq-53",
    blockedReason: null,
    lastError: null,
    attemptCount: 2,
  });
  const parsed = parseLinearDescriptionMachineState(rewritten);

  assert.equal(parsed.description, "Body\n\nPostscript from a human.");
  assert.match(
    rewritten,
    /Postscript from a human\.<!-- orqestrate:machine-state:boundary -->[\s\S]*<!-- orqestrate:machine-state:end -->$/,
  );
});

test("rejects duplicate machine-state blocks", () => {
  const first = upsertLinearDescriptionMachineState("Ticket body.", {
    owner: null,
    runId: null,
    leaseUntil: null,
    artifactUrl: null,
    blockedReason: null,
    lastError: null,
    attemptCount: 0,
  });
  const duplicate = `${first}\n\n${first}`;

  assert.throws(
    () => parseLinearDescriptionMachineState(duplicate),
    /duplicate machine-state sentinels/i,
  );
});

test("rejects invalid JSON in the machine-state block", () => {
  const malformed = [
    "Ticket body.",
    "",
    "Do not edit the machine-state block below manually.",
    "",
    "<!-- orqestrate:machine-state:start -->",
    "```json",
    "{\"owner\": \"worker-1\",",
    "```",
    "<!-- orqestrate:machine-state:end -->",
  ].join("\n");

  assert.throws(
    () => parseLinearDescriptionMachineState(malformed),
    /invalid json/i,
  );
});
