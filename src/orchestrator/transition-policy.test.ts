import assert from "node:assert/strict";
import test from "node:test";

import type { WorkItemRecord } from "../domain-model.js";

import {
  HumanBlockerError,
  buildBlockedTransition,
  buildRetryableFailureTransition,
  defaultClassifyPostClaimFailure,
} from "./transition-policy.js";

test("builds retryable transitions that preserve the current phase and status", () => {
  const transition = buildRetryableFailureTransition({
    workItem: createWorkItem(),
    runId: "run-1",
    error: {
      providerFamily: "context",
      providerKind: "notion",
      code: "transport",
      message: "temporary failure",
      retryable: true,
      details: null,
    },
  });

  assert.deepEqual(transition, {
    id: "ORQ-37",
    nextStatus: "implement",
    nextPhase: "implement",
    state: "failed",
    lastError: {
      providerFamily: "context",
      providerKind: "notion",
      code: "transport",
      message: "temporary failure",
      retryable: true,
      details: null,
    },
    blockedReason: null,
    runId: "run-1",
  });
});

test("builds blocked transitions that preserve the current phase while moving status to blocked", () => {
  const transition = buildBlockedTransition({
    workItem: createWorkItem(),
    runId: "run-2",
    blockedReason: "Need product signoff",
  });

  assert.deepEqual(transition, {
    id: "ORQ-37",
    nextStatus: "blocked",
    nextPhase: "implement",
    state: "waiting_human",
    blockedReason: "Need product signoff",
    lastError: null,
    runId: "run-2",
  });
});

test("classifies explicit human blockers as blocked transitions", () => {
  const disposition = defaultClassifyPostClaimFailure(
    new HumanBlockerError("Need product signoff"),
    {
      claimedWorkItem: createWorkItem(),
      phase: "implement",
      runId: "run-3",
      step: "load_context",
    },
  );

  assert.deepEqual(disposition, {
    kind: "blocked",
    blockedReason: "Need product signoff",
    error: null,
  });
});

test("maps generic context failures into retryable provider errors", () => {
  const disposition = defaultClassifyPostClaimFailure(new Error("network down"), {
    claimedWorkItem: createWorkItem(),
    phase: "implement",
    runId: "run-4",
    step: "ensure_artifact",
  });

  assert.equal(disposition.kind, "retryable");
  assert.equal(disposition.error.providerFamily, "context");
  assert.equal(disposition.error.providerKind, "context_backend");
  assert.equal(disposition.error.message, "network down");
  assert.equal(disposition.error.retryable, true);
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
