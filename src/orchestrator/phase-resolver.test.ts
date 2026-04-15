import assert from "node:assert/strict";
import test from "node:test";

import type { WorkItemRecord } from "../domain-model.js";

import { resolvePhase } from "./phase-resolver.js";

test("resolves actionable phases when status and canonical phase agree", () => {
  const result = resolvePhase(createWorkItem({ status: "implement", phase: "implement" }));

  assert.deepEqual(result, {
    actionable: true,
    phase: "implement",
  });
});

test("fails closed when an actionable status has no canonical phase", () => {
  const result = resolvePhase(createWorkItem({ status: "plan", phase: "none" }));

  assert.equal(result.actionable, false);
  assert.equal(result.reason, "phase_missing");
  assert.equal(result.expectedPhase, "plan");
});

test("fails closed when actionable status and phase disagree", () => {
  const result = resolvePhase(createWorkItem({ status: "review", phase: "implement" }));

  assert.equal(result.actionable, false);
  assert.equal(result.reason, "phase_mismatch");
  assert.equal(result.expectedPhase, "review");
});

test("treats blocked items as non-actionable while preserving the current phase", () => {
  const result = resolvePhase(createWorkItem({ status: "blocked", phase: "implement" }));

  assert.equal(result.actionable, false);
  assert.equal(result.reason, "blocked_status");
  assert.equal(result.phase, "implement");
});

test("rejects the reserved merge phase", () => {
  const result = resolvePhase(createWorkItem({ status: "implement", phase: "merge" }));

  assert.equal(result.actionable, false);
  assert.equal(result.reason, "reserved_phase");
  assert.equal(result.expectedPhase, "implement");
});

function createWorkItem(
  overrides: Partial<WorkItemRecord> = {},
): WorkItemRecord {
  return {
    id: overrides.id ?? "ORQ-37",
    identifier: overrides.identifier ?? "ORQ-37",
    title: overrides.title ?? "Implement orchestrator core",
    description: overrides.description ?? "Claim and prepare work safely.",
    status: overrides.status ?? "implement",
    phase: overrides.phase ?? "implement",
    priority: overrides.priority ?? 1,
    labels: overrides.labels ?? [],
    url: overrides.url ?? "https://linear.app/orqestrate/issue/ORQ-37",
    parentId: overrides.parentId ?? null,
    dependencyIds: overrides.dependencyIds ?? [],
    blockedByIds: overrides.blockedByIds ?? [],
    blocksIds: overrides.blocksIds ?? [],
    artifactUrl: overrides.artifactUrl ?? null,
    updatedAt: overrides.updatedAt ?? "2026-04-15T00:00:00.000Z",
    createdAt: overrides.createdAt ?? "2026-04-14T00:00:00.000Z",
    orchestration: overrides.orchestration ?? {
      state: "queued",
      owner: null,
      runId: null,
      leaseUntil: null,
      reviewOutcome: "none",
      blockedReason: null,
      lastError: null,
      attemptCount: 0,
    },
  };
}
