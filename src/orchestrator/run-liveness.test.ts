import assert from "node:assert/strict";
import test from "node:test";

import type { WorkItemRecord } from "../domain-model.js";

import { evaluateLeaseRenewal } from "./run-liveness.js";
import type { ObservedRuntimeRun } from "./runtime-observer.js";

test("renews a due lease when runtime evidence advanced", () => {
  const workItem = createWorkItem({
    orchestration: {
      state: "claimed",
      owner: "orchestrator:test",
      runId: "run-39",
      leaseUntil: "2026-04-15T00:00:10.000Z",
      reviewOutcome: "none",
      blockedReason: null,
      lastError: null,
      attemptCount: 1,
    },
  });
  const run = createRuntimeRun({
    runId: "run-39",
    status: "running",
    lastHeartbeatAt: "2026-04-15T00:00:08.000Z",
    lastEventSeq: 8,
  });

  const decision = evaluateLeaseRenewal({
    workItem,
    runtimeRun: run,
    runtimeHealthy: true,
    observation: {
      runId: "run-39",
      workItemId: workItem.id,
      status: "bootstrapping",
      leaseUntil: workItem.orchestration.leaseUntil ?? null,
      lastHeartbeatAt: "2026-04-15T00:00:04.000Z",
      lastEventSeq: 4,
      observedAt: "2026-04-15T00:00:04.000Z",
    },
    now: new Date("2026-04-15T00:00:09.000Z"),
    leaseDurationMs: 60_000,
    renewalThresholdMs: 5_000,
  });

  assert.equal(decision.renew, true);
  assert.equal(decision.promoteToRunning, true);
  assert.equal(decision.reason, "fresh_evidence");
  assert.match(decision.nextLeaseUntil ?? "", /2026-04-15T00:01:09.000Z/);
});

test("skips renewal while runtime health is degraded", () => {
  const workItem = createWorkItem({
    orchestration: {
      state: "running",
      owner: "orchestrator:test",
      runId: "run-39",
      leaseUntil: "2026-04-15T00:00:10.000Z",
      reviewOutcome: "none",
      blockedReason: null,
      lastError: null,
      attemptCount: 1,
    },
  });
  const run = createRuntimeRun({
    runId: "run-39",
    status: "running",
    lastHeartbeatAt: "2026-04-15T00:00:08.000Z",
  });

  const decision = evaluateLeaseRenewal({
    workItem,
    runtimeRun: run,
    runtimeHealthy: false,
    now: new Date("2026-04-15T00:00:09.000Z"),
    leaseDurationMs: 60_000,
    renewalThresholdMs: 5_000,
  });

  assert.equal(decision.renew, false);
  assert.equal(decision.reason, "runtime_unhealthy");
});

test("allows one bootstrap-grace renewal without fresh heartbeat evidence", () => {
  const workItem = createWorkItem({
    orchestration: {
      state: "claimed",
      owner: "orchestrator:test",
      runId: "run-39",
      leaseUntil: "2026-04-15T00:00:10.000Z",
      reviewOutcome: "none",
      blockedReason: null,
      lastError: null,
      attemptCount: 1,
    },
  });
  const run = createRuntimeRun({
    runId: "run-39",
    status: "bootstrapping",
    admittedAt: "2026-04-15T00:00:00.000Z",
    startedAt: "2026-04-15T00:00:05.000Z",
    lastEventSeq: 2,
    lastHeartbeatAt: null,
  });

  const decision = evaluateLeaseRenewal({
    workItem,
    runtimeRun: run,
    runtimeHealthy: true,
    observation: {
      runId: "run-39",
      workItemId: workItem.id,
      status: "bootstrapping",
      leaseUntil: workItem.orchestration.leaseUntil ?? null,
      lastHeartbeatAt: null,
      lastEventSeq: 2,
      observedAt: "2026-04-15T00:00:06.000Z",
    },
    now: new Date("2026-04-15T00:00:09.000Z"),
    leaseDurationMs: 60_000,
    renewalThresholdMs: 5_000,
  });

  assert.equal(decision.renew, true);
  assert.equal(decision.reason, "bootstrap_grace");
});

test("stops renewal once the runtime hands control back to a human", () => {
  const workItem = createWorkItem({
    orchestration: {
      state: "running",
      owner: "orchestrator:test",
      runId: "run-39",
      leaseUntil: "2026-04-15T00:00:10.000Z",
      reviewOutcome: "none",
      blockedReason: null,
      lastError: null,
      attemptCount: 1,
    },
  });
  const run = createRuntimeRun({
    runId: "run-39",
    status: "waiting_human",
  });

  const decision = evaluateLeaseRenewal({
    workItem,
    runtimeRun: run,
    runtimeHealthy: true,
    now: new Date("2026-04-15T00:00:09.000Z"),
    leaseDurationMs: 60_000,
    renewalThresholdMs: 5_000,
  });

  assert.equal(decision.renew, false);
  assert.equal(decision.reason, "runtime_not_active");
});

function createWorkItem(overrides: Partial<WorkItemRecord> = {}): WorkItemRecord {
  return {
    id: overrides.id ?? "ORQ-39",
    identifier: overrides.identifier ?? "ORQ-39",
    title: overrides.title ?? "Implement poll-based reconciliation",
    description: overrides.description ?? null,
    status: overrides.status ?? "implement",
    phase: overrides.phase ?? "implement",
    priority: overrides.priority ?? 1,
    labels: overrides.labels ?? [],
    url: overrides.url ?? "https://linear.app/orqestrate/issue/ORQ-39",
    parentId: overrides.parentId ?? null,
    dependencyIds: overrides.dependencyIds ?? [],
    blockedByIds: overrides.blockedByIds ?? [],
    blocksIds: overrides.blocksIds ?? [],
    artifactUrl: overrides.artifactUrl ?? null,
    updatedAt: overrides.updatedAt ?? "2026-04-15T00:00:00.000Z",
    createdAt: overrides.createdAt ?? "2026-04-14T00:00:00.000Z",
    orchestration: overrides.orchestration ?? {
      state: "claimed",
      owner: "orchestrator:test",
      runId: "run-39",
      leaseUntil: "2026-04-15T00:00:10.000Z",
      reviewOutcome: "none",
      blockedReason: null,
      lastError: null,
      attemptCount: 1,
    },
  };
}

function createRuntimeRun(
  overrides: Partial<ObservedRuntimeRun> = {},
): ObservedRuntimeRun {
  return {
    runId: overrides.runId ?? "run-39",
    workItemId: overrides.workItemId ?? "ORQ-39",
    workItemIdentifier: overrides.workItemIdentifier ?? "ORQ-39",
    phase: overrides.phase ?? "implement",
    provider: overrides.provider ?? "codex",
    status: overrides.status ?? "running",
    repoRoot: overrides.repoRoot ?? "/tmp/orqestrate",
    workspace: overrides.workspace ?? {
      mode: "ephemeral_worktree",
    },
    artifactUrl: overrides.artifactUrl ?? null,
    requestedBy: overrides.requestedBy ?? null,
    promptContractId: overrides.promptContractId ?? "orqestrate/implement/v1",
    promptDigests: overrides.promptDigests ?? {
      system: null,
      user: "digest",
    },
    limits: overrides.limits ?? {
      maxWallTimeSec: 3600,
      idleTimeoutSec: 300,
      bootstrapTimeoutSec: 120,
    },
    outcome: overrides.outcome ?? null,
    createdAt: overrides.createdAt ?? "2026-04-15T00:00:00.000Z",
    admittedAt: overrides.admittedAt ?? "2026-04-15T00:00:01.000Z",
    startedAt: overrides.startedAt ?? "2026-04-15T00:00:02.000Z",
    completedAt: overrides.completedAt ?? null,
    lastHeartbeatAt:
      overrides.lastHeartbeatAt === undefined
        ? "2026-04-15T00:00:05.000Z"
        : overrides.lastHeartbeatAt,
    lastEventSeq: overrides.lastEventSeq ?? 5,
    priority: overrides.priority ?? 100,
    runtimeOwner: overrides.runtimeOwner ?? "runtime-daemon:test",
    attemptCount: overrides.attemptCount ?? 1,
    waitingHumanReason: overrides.waitingHumanReason ?? null,
    readyAt: overrides.readyAt ?? "2026-04-15T00:00:03.000Z",
    version: overrides.version ?? 1,
  };
}
