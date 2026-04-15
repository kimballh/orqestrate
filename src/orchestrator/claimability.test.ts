import assert from "node:assert/strict";
import test from "node:test";

import type { WorkItemRecord } from "../domain-model.js";

import { evaluateClaimability } from "./claimability.js";
import type { PhaseResolution } from "./types.js";

test("allows actionable items with no active lease or blockers", () => {
  const decision = evaluateClaimability(
    createWorkItem(),
    actionableResolution("implement"),
    new Date("2026-04-15T00:00:00.000Z"),
  );

  assert.deepEqual(decision, {
    claimable: true,
    phase: "implement",
    hasExpiredLease: false,
  });
});

test("blocks items that still have an active lease", () => {
  const decision = evaluateClaimability(
    createWorkItem({
      orchestration: {
        state: "claimed",
        owner: "orchestrator:a",
        runId: "run-1",
        leaseUntil: "2026-04-15T01:00:00.000Z",
        reviewOutcome: "none",
        blockedReason: null,
        lastError: null,
        attemptCount: 1,
      },
    }),
    actionableResolution("implement"),
    new Date("2026-04-15T00:00:00.000Z"),
  );

  assert.equal(decision.claimable, false);
  assert.equal(decision.reason, "lease_active");
});

test("fails closed when an in-flight item has no recorded lease", () => {
  const decision = evaluateClaimability(
    createWorkItem({
      orchestration: {
        state: "running",
        owner: "orchestrator:a",
        runId: "run-1",
        leaseUntil: null,
        reviewOutcome: "none",
        blockedReason: null,
        lastError: null,
        attemptCount: 1,
      },
    }),
    actionableResolution("implement"),
    new Date("2026-04-15T00:00:00.000Z"),
  );

  assert.equal(decision.claimable, false);
  assert.equal(decision.reason, "lease_missing");
});

test("treats expired leases as reclaimable", () => {
  const decision = evaluateClaimability(
    createWorkItem({
      orchestration: {
        state: "running",
        owner: "orchestrator:a",
        runId: "run-1",
        leaseUntil: "2026-04-14T23:59:00.000Z",
        reviewOutcome: "none",
        blockedReason: null,
        lastError: null,
        attemptCount: 1,
      },
    }),
    actionableResolution("implement"),
    new Date("2026-04-15T00:00:00.000Z"),
  );

  assert.deepEqual(decision, {
    claimable: true,
    phase: "implement",
    hasExpiredLease: true,
  });
});

test("blocks items waiting on human input", () => {
  const decision = evaluateClaimability(
    createWorkItem({
      orchestration: {
        state: "waiting_human",
        owner: null,
        runId: null,
        leaseUntil: null,
        reviewOutcome: "none",
        blockedReason: "Need signoff",
        lastError: null,
        attemptCount: 1,
      },
    }),
    actionableResolution("review"),
  );

  assert.equal(decision.claimable, false);
  assert.equal(decision.reason, "waiting_human");
});

test("blocks items with open dependencies", () => {
  const decision = evaluateClaimability(
    createWorkItem({
      blockedByIds: ["ORQ-30"],
    }),
    actionableResolution("implement"),
  );

  assert.equal(decision.claimable, false);
  assert.equal(decision.reason, "has_open_blockers");
});

test("propagates non-actionable phase results into a non-claimable decision", () => {
  const decision = evaluateClaimability(
    createWorkItem(),
    {
      actionable: false,
      reason: "phase_missing",
      message: "missing phase",
      phase: "none",
      expectedPhase: "implement",
    },
  );

  assert.equal(decision.claimable, false);
  assert.equal(decision.reason, "phase_not_actionable");
});

function actionableResolution(phase: "design" | "plan" | "implement" | "review"): PhaseResolution {
  return {
    actionable: true,
    phase,
  };
}

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
