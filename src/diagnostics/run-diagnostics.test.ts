import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeApiRun } from "../runtime/api/types.js";
import type { RunEventRecord } from "../runtime/types.js";

import { buildRunDiagnostics, buildRunListEntry } from "./run-diagnostics.js";

test("buildRunDiagnostics renders overview, timeline, and prompt provenance for a completed run", () => {
  const run = createRun({
    status: "completed",
    completedAt: "2026-04-15T18:15:00.000Z",
    outcome: {
      code: "completed",
      summary: "Run completed cleanly.",
      details: "No issues detected.",
      error: null,
    },
  });
  const events = createEvents([
    ["run_enqueued", "2026-04-15T18:00:00.000Z", {}, "api", "info"],
    ["run_admitted", "2026-04-15T18:01:00.000Z", { runtimeOwner: "runtime-1" }, "scheduler", "info"],
    ["session_started", "2026-04-15T18:02:00.000Z", {}, "supervisor", "info"],
    ["session_ready", "2026-04-15T18:03:00.000Z", {}, "provider", "info"],
    ["run_completed", "2026-04-15T18:15:00.000Z", { status: "completed" }, "provider", "info"],
  ]);

  const diagnostics = buildRunDiagnostics(run, events);

  assert.equal(diagnostics.overview.headline, "Run completed cleanly.");
  assert.equal(diagnostics.overview.queueDurationMs, 60_000);
  assert.equal(diagnostics.overview.launchDurationMs, 120_000);
  assert.equal(diagnostics.overview.executionDurationMs, 720_000);
  assert.equal(diagnostics.timeline.entries[1]?.summary, "Runtime admitted the run and reserved execution capacity.");
  assert.equal(diagnostics.prompt.status, "available");
  assert.equal(diagnostics.prompt.selection?.promptPackName, "default");
  assert.equal(diagnostics.failure.category, "none");
  assert.deepEqual(buildRunListEntry(run), {
    runId: "run-001",
    workItemId: "issue-48",
    workItemIdentifier: "ORQ-48",
    phase: "implement",
    provider: "codex",
    status: "completed",
    createdAt: "2026-04-15T18:00:00.000Z",
    headline: "Run completed cleanly.",
  });
});

test("buildRunDiagnostics surfaces waiting-human state with requested input guidance", () => {
  const run = createRun({
    status: "waiting_human",
    outcome: {
      requestedHumanInput: "Choose the provider adapter path.",
      error: null,
    },
    waitingHumanReason: "Choose the provider adapter path.",
    promptProvenance: null,
  });
  const events = createEvents([
    ["run_enqueued", "2026-04-15T18:00:00.000Z", {}, "api", "info"],
    [
      "waiting_human",
      "2026-04-15T18:10:00.000Z",
      { reason: "Choose the provider adapter path." },
      "provider",
      "info",
    ],
  ]);

  const diagnostics = buildRunDiagnostics(run, events);

  assert.equal(
    diagnostics.failure.headline,
    "Waiting for human input: Choose the provider adapter path.",
  );
  assert.equal(diagnostics.failure.category, "waiting_human");
  assert.match(diagnostics.prompt.note ?? "", /predates provenance persistence/);
  assert.equal(
    diagnostics.timeline.entries.at(-1)?.summary,
    "Run paused for operator input: Choose the provider adapter path.",
  );
});

test("buildRunDiagnostics maps common failure heuristics from runtime issue events", () => {
  const run = createRun({
    status: "failed",
    completedAt: "2026-04-15T18:05:00.000Z",
    outcome: {
      code: "provider_bootstrap_timeout",
      summary: "Provider failed to bootstrap in time.",
      error: {
        providerFamily: "runtime",
        providerKind: "codex",
        code: "timeout",
        message: "Provider bootstrap timed out.",
        retryable: true,
        details: null,
      },
    },
  });
  const events = createEvents([
    ["run_enqueued", "2026-04-15T18:00:00.000Z", {}, "api", "info"],
    ["run_admitted", "2026-04-15T18:01:00.000Z", { runtimeOwner: "runtime-1" }, "scheduler", "info"],
    [
      "runtime_issue_detected",
      "2026-04-15T18:04:00.000Z",
      {
        code: "provider_bootstrap_timeout",
        message: "Provider bootstrap timed out.",
        retryable: true,
        bootstrapTimeoutSec: 120,
      },
      "provider",
      "warn",
    ],
    ["run_failed", "2026-04-15T18:05:00.000Z", { status: "failed" }, "provider", "info"],
  ]);

  const diagnostics = buildRunDiagnostics(run, events);

  assert.equal(diagnostics.failure.category, "provider");
  assert.equal(diagnostics.failure.headline, "Provider bootstrap timed out.");
  assert.match(
    diagnostics.failure.recommendedActions.join("\n"),
    /Check provider binary availability and auth state before retrying/,
  );
  assert.equal(
    diagnostics.timeline.entries.at(-2)?.summary,
    "Runtime issue detected (provider_bootstrap_timeout): Provider bootstrap timed out.",
  );
});

function createRun(overrides: Partial<RuntimeApiRun> = {}): RuntimeApiRun {
  return {
    runId: "run-001",
    workItemId: "issue-48",
    workItemIdentifier: "ORQ-48",
    phase: "implement",
    provider: "codex",
    status: "running",
    repoRoot: "/repo",
    workspace: {
      mode: "ephemeral_worktree",
      assignedBranch: "hillkimball/orq-48",
      pullRequestUrl: "https://github.com/kimballh/orqestrate/pull/48",
      writeScope: "repo",
    },
    artifactUrl: "https://www.notion.so/orq-48",
    requestedBy: "Kimball Hill",
    grantedCapabilities: ["github.read_pr", "github.push_branch"],
    promptContractId: "orqestrate/implement/v1",
    promptDigests: {
      system: "sha256-system",
      user: "sha256-user",
    },
    promptProvenance: {
      selection: {
        promptPackName: "default",
        capabilityNames: ["github.read_pr"],
        organizationOverlayNames: ["reviewer_qa"],
        projectOverlayNames: ["reviewer_webapp"],
        experimentName: "reviewer_v2",
      },
      sources: [
        {
          kind: "base_pack",
          ref: "prompt-pack:default/base/system.md",
          digest: "sha256:base-pack",
        },
      ],
      rendered: {
        systemPromptLength: 412,
        userPromptLength: 1867,
        attachmentKinds: ["planning_url", "artifact_url"],
        attachmentCount: 2,
      },
    },
    limits: {
      maxWallTimeSec: 5400,
      idleTimeoutSec: 900,
      bootstrapTimeoutSec: 120,
    },
    outcome: null,
    createdAt: "2026-04-15T18:00:00.000Z",
    admittedAt: "2026-04-15T18:01:00.000Z",
    startedAt: "2026-04-15T18:02:00.000Z",
    readyAt: "2026-04-15T18:03:00.000Z",
    completedAt: null,
    lastHeartbeatAt: "2026-04-15T18:04:30.000Z",
    priority: 3,
    runtimeOwner: "runtime-1",
    attemptCount: 1,
    waitingHumanReason: null,
    version: 1,
    lastEventSeq: 4,
    ...overrides,
  };
}

function createEvents(
  entries: Array<
    [
      eventType: string,
      occurredAt: string,
      payload: Record<string, unknown>,
      source: RunEventRecord["source"],
      level: RunEventRecord["level"],
    ]
  >,
): RunEventRecord[] {
  return entries.map(([eventType, occurredAt, payload, source, level], index) => ({
    seq: index + 1,
    runId: "run-001",
    eventType,
    level,
    source,
    occurredAt,
    payload,
  }));
}
