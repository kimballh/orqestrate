import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import type { WorkItemRecord } from "../../domain-model.js";

import { LocalFilesPlanningBackend } from "./local-files-backend.js";

test("bootstraps an empty planning root", async (t) => {
  const root = await createTempPlanningRoot();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const backend = createBackend(root);
  await backend.validateConfig();

  const index = JSON.parse(
    await readFile(path.join(root, "index.json"), "utf8"),
  ) as { version: number; items: unknown[] };

  assert.equal(index.version, 1);
  assert.deepEqual(index.items, []);
  assert.deepEqual(await backend.listActionableWorkItems({ limit: 10 }), []);
  assert.equal(await backend.getWorkItem("ISSUE-1"), null);
});

test("lists actionable items and hydrates work items from local files", async (t) => {
  const root = await createTempPlanningRoot();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await seedIssues(root, [
    createWorkItem({
      id: "ISSUE-1",
      title: "Oldest urgent issue",
      status: "implement",
      phase: "implement",
      priority: 1,
      updatedAt: "2026-04-14T00:00:00.000Z",
    }),
    createWorkItem({
      id: "ISSUE-2",
      title: "Leased issue",
      status: "implement",
      phase: "implement",
      priority: 1,
      updatedAt: "2026-04-14T00:10:00.000Z",
      orchestration: {
        state: "running",
        owner: "orchestrator-1",
        runId: "run-2",
        leaseUntil: "2099-04-14T00:15:00.000Z",
      },
    }),
    createWorkItem({
      id: "ISSUE-3",
      title: "Blocked issue",
      status: "plan",
      phase: "plan",
      priority: 2,
      blockedByIds: ["ISSUE-4"],
      updatedAt: "2026-04-14T00:05:00.000Z",
    }),
    createWorkItem({
      id: "ISSUE-4",
      title: "Open blocker",
      status: "review",
      phase: "review",
      priority: 2,
      updatedAt: "2026-04-14T00:01:00.000Z",
    }),
    createWorkItem({
      id: "ISSUE-5",
      title: "Backlog issue",
      status: "backlog",
      phase: "none",
      priority: 0,
      updatedAt: "2026-04-14T00:02:00.000Z",
    }),
    createWorkItem({
      id: "ISSUE-6",
      title: "Second actionable issue",
      status: "plan",
      phase: "plan",
      priority: 2,
      updatedAt: "2026-04-14T00:02:00.000Z",
    }),
  ]);

  const backend = createBackend(root);
  await backend.validateConfig();

  const workItem = await backend.getWorkItem("ISSUE-1");
  assert.equal(workItem?.title, "Oldest urgent issue");

  const actionable = await backend.listActionableWorkItems({ limit: 10 });
  assert.deepEqual(
    actionable.map((item) => item.id),
    ["ISSUE-1", "ISSUE-4", "ISSUE-6"],
  );

  const planOnly = await backend.listActionableWorkItems({
    phases: ["plan"],
    limit: 10,
  });
  assert.deepEqual(planOnly.map((item) => item.id), ["ISSUE-6"]);
});

test("claims work items and rejects active-lease conflicts", async (t) => {
  const root = await createTempPlanningRoot();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await seedIssues(root, [
    createWorkItem({
      id: "ISSUE-1",
      status: "implement",
      phase: "implement",
    }),
    createWorkItem({
      id: "ISSUE-2",
      status: "implement",
      phase: "implement",
      orchestration: {
        state: "claimed",
        owner: "orchestrator-1",
        runId: "run-active",
        leaseUntil: "2099-04-14T01:00:00.000Z",
      },
    }),
    createWorkItem({
      id: "ISSUE-3",
      status: "backlog",
      phase: "none",
    }),
  ]);

  const backend = createBackend(root);
  await backend.validateConfig();

  const claimed = await backend.claimWorkItem({
    id: "ISSUE-1",
    phase: "implement",
    owner: "orchestrator-1",
    runId: "run-claim-1",
    leaseUntil: "2099-04-14T01:00:00.000Z",
  });

  assert.equal(claimed.orchestration.state, "claimed");
  assert.equal(claimed.orchestration.attemptCount, 1);

  await assert.rejects(
    () =>
      backend.claimWorkItem({
        id: "ISSUE-2",
        phase: "implement",
        owner: "orchestrator-2",
        runId: "run-claim-2",
        leaseUntil: "2099-04-14T01:05:00.000Z",
      }),
    /active lease/i,
  );

  await assert.rejects(
    () =>
      backend.claimWorkItem({
        id: "ISSUE-3",
        phase: "implement",
        owner: "orchestrator-2",
        runId: "run-claim-3",
        leaseUntil: "2099-04-14T01:05:00.000Z",
      }),
    /cannot be claimed/i,
  );
});

test("enforces ownership on running and lease renewal operations", async (t) => {
  const root = await createTempPlanningRoot();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await seedIssues(root, [
    createWorkItem({
      id: "ISSUE-1",
      status: "implement",
      phase: "implement",
      orchestration: {
        state: "claimed",
        owner: "orchestrator-1",
        runId: "run-1",
        leaseUntil: "2099-04-14T01:00:00.000Z",
      },
    }),
  ]);

  const backend = createBackend(root);
  await backend.validateConfig();

  await assert.rejects(
    () =>
      backend.markWorkItemRunning({
        id: "ISSUE-1",
        owner: "orchestrator-2",
        runId: "run-1",
        leaseUntil: "2099-04-14T01:05:00.000Z",
      }),
    /owned by/i,
  );

  const running = await backend.markWorkItemRunning({
    id: "ISSUE-1",
    owner: "orchestrator-1",
    runId: "run-1",
    leaseUntil: "2099-04-14T01:05:00.000Z",
  });

  assert.equal(running.orchestration.state, "running");

  await assert.rejects(
    () =>
      backend.renewLease({
        id: "ISSUE-1",
        owner: "orchestrator-1",
        runId: "run-2",
        leaseUntil: "2099-04-14T01:10:00.000Z",
      }),
    /leased to run/i,
  );

  const renewed = await backend.renewLease({
    id: "ISSUE-1",
    owner: "orchestrator-1",
    runId: "run-1",
    leaseUntil: "2099-04-14T01:10:00.000Z",
  });

  assert.equal(renewed.orchestration.leaseUntil, "2099-04-14T01:10:00.000Z");
});

test("preserves blocked phase and clears terminal phases on transitions", async (t) => {
  const root = await createTempPlanningRoot();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await seedIssues(root, [
    createWorkItem({
      id: "ISSUE-1",
      status: "implement",
      phase: "implement",
      orchestration: {
        state: "running",
        owner: "orchestrator-1",
        runId: "run-1",
        leaseUntil: "2099-04-14T01:00:00.000Z",
      },
    }),
    createWorkItem({
      id: "ISSUE-2",
      status: "review",
      phase: "review",
      orchestration: {
        state: "running",
        owner: "reviewer-1",
        runId: "run-2",
        leaseUntil: "2099-04-14T01:05:00.000Z",
        reviewOutcome: "changes_requested",
        attemptCount: 3,
      },
    }),
    createWorkItem({
      id: "ISSUE-3",
      status: "implement",
      phase: "implement",
      orchestration: {
        state: "completed",
        owner: null,
        runId: "run-3",
        leaseUntil: null,
        reviewOutcome: "changes_requested",
        attemptCount: 2,
      },
    }),
  ]);

  const backend = createBackend(root);
  await backend.validateConfig();

  const blocked = await backend.transitionWorkItem({
    id: "ISSUE-1",
    nextStatus: "blocked",
    nextPhase: "none",
    state: "waiting_human",
    blockedReason: "missing credentials",
    runId: "run-1",
  });

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.phase, "implement");
  assert.equal(blocked.orchestration.owner, null);
  assert.equal(blocked.orchestration.leaseUntil, null);
  assert.equal(blocked.orchestration.blockedReason, "missing credentials");

  const done = await backend.transitionWorkItem({
    id: "ISSUE-2",
    nextStatus: "done",
    nextPhase: "none",
    state: "completed",
    runId: "run-2",
  });

  assert.equal(done.phase, "none");
  assert.equal(done.orchestration.owner, null);
  assert.equal(done.orchestration.leaseUntil, null);
  assert.equal(done.orchestration.reviewOutcome, "none");
  assert.equal(done.orchestration.attemptCount, 0);

  const movedToReview = await backend.transitionWorkItem({
    id: "ISSUE-3",
    nextStatus: "review",
    nextPhase: "review",
    state: "completed",
    runId: "run-3",
  });

  assert.equal(movedToReview.phase, "review");
  assert.equal(movedToReview.orchestration.reviewOutcome, "none");
  assert.equal(movedToReview.orchestration.attemptCount, 0);

  const claimedReview = await backend.claimWorkItem({
    id: "ISSUE-3",
    phase: "review",
    owner: "reviewer-2",
    runId: "run-4",
    leaseUntil: "2099-04-14T01:10:00.000Z",
  });

  assert.equal(claimedReview.orchestration.attemptCount, 1);
});

test("appends comments, updates timestamps, and returns local deep links", async (t) => {
  const root = await createTempPlanningRoot();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await seedIssues(root, [
    createWorkItem({
      id: "ISSUE-1",
      status: "plan",
      phase: "plan",
    }),
  ]);

  const backend = createBackend(root);
  await backend.validateConfig();

  const before = await backend.getWorkItem("ISSUE-1");
  await backend.appendComment({
    id: "ISSUE-1",
    body: "First operator note",
  });
  await backend.appendComment({
    id: "ISSUE-1",
    body: "Second operator note",
  });

  const comments = await readFile(
    path.join(root, "comments", "ISSUE-1.md"),
    "utf8",
  );
  const after = await backend.getWorkItem("ISSUE-1");
  const deepLink = await backend.buildDeepLink("ISSUE-1");

  assert.match(comments, /First operator note/);
  assert.match(comments, /Second operator note/);
  assert.ok(before);
  assert.ok(after);
  assert.notEqual(after.updatedAt, before.updatedAt);
  assert.equal(
    deepLink,
    pathToFileURL(path.join(root, "issues", "ISSUE-1.json")).toString(),
  );
});

test("rejects malformed issue files, duplicate identifiers, and stale indexes", async (t) => {
  const malformedRoot = await createTempPlanningRoot();
  t.after(async () => {
    await rm(malformedRoot, { recursive: true, force: true });
  });

  await writeIssueFile(
    malformedRoot,
    "BROKEN",
    "{ not-json }\n",
  );

  const malformedBackend = createBackend(malformedRoot);
  await assert.rejects(() => malformedBackend.validateConfig(), /Invalid JSON/i);

  const duplicateRoot = await createTempPlanningRoot();
  t.after(async () => {
    await rm(duplicateRoot, { recursive: true, force: true });
  });

  await seedIssues(duplicateRoot, [
    createWorkItem({
      id: "ISSUE-1",
      identifier: "ORQ-23",
    }),
    createWorkItem({
      id: "ISSUE-2",
      identifier: "ORQ-23",
    }),
  ]);

  const duplicateBackend = createBackend(duplicateRoot);
  await assert.rejects(
    () => duplicateBackend.validateConfig(),
    /Duplicate issue identifier/i,
  );

  const invalidErrorRoot = await createTempPlanningRoot();
  t.after(async () => {
    await rm(invalidErrorRoot, { recursive: true, force: true });
  });

  await writeIssueFile(
    invalidErrorRoot,
    "BAD-ERROR",
    `${JSON.stringify({
      ...createWorkItem({ id: "BAD-ERROR" }),
      orchestration: {
        ...createWorkItem({ id: "BAD-ERROR" }).orchestration,
        lastError: { oops: true },
      },
    }, null, 2)}\n`,
  );

  const invalidErrorBackend = createBackend(invalidErrorRoot);
  await assert.rejects(
    () => invalidErrorBackend.validateConfig(),
    /providerFamily/i,
  );

  const staleRoot = await createTempPlanningRoot();
  t.after(async () => {
    await rm(staleRoot, { recursive: true, force: true });
  });

  await seedIssues(staleRoot, [createWorkItem({ id: "ISSUE-1" })]);
  const staleBackend = createBackend(staleRoot);
  await staleBackend.validateConfig();

  const staleIndexPath = path.join(staleRoot, "index.json");
  const staleIndex = JSON.parse(
    await readFile(staleIndexPath, "utf8"),
  ) as { version: number; updatedAt: string; items: Array<Record<string, unknown>> };
  staleIndex.items[0]!.title = "Stale title";
  await writeFile(staleIndexPath, `${JSON.stringify(staleIndex, null, 2)}\n`, "utf8");

  await assert.rejects(() => staleBackend.validateConfig(), /stale or mismatched/i);
});

function createBackend(root: string): LocalFilesPlanningBackend {
  return new LocalFilesPlanningBackend({
    name: "local_planning",
    kind: "planning.local_files",
    family: "planning",
    root,
  });
}

function createWorkItem(
  overrides: Omit<Partial<WorkItemRecord>, "orchestration"> & {
    id: string;
    orchestration?: Partial<WorkItemRecord["orchestration"]>;
  },
): WorkItemRecord {
  const status = overrides.status ?? "implement";
  const phase =
    overrides.phase ??
    (status === "backlog" || status === "done" || status === "canceled"
      ? "none"
      : status === "blocked"
        ? "implement"
        : status);

  return {
    id: overrides.id,
    identifier: overrides.identifier ?? overrides.id,
    title: overrides.title ?? overrides.id,
    description: overrides.description ?? `Description for ${overrides.id}`,
    status,
    phase,
    priority: overrides.priority ?? 2,
    labels: overrides.labels ?? [],
    url: overrides.url ?? null,
    parentId: overrides.parentId ?? null,
    dependencyIds: overrides.dependencyIds ?? [],
    blockedByIds: overrides.blockedByIds ?? [],
    blocksIds: overrides.blocksIds ?? [],
    artifactUrl: overrides.artifactUrl ?? null,
    updatedAt: overrides.updatedAt ?? "2026-04-14T00:00:00.000Z",
    createdAt: overrides.createdAt ?? "2026-04-13T23:00:00.000Z",
    orchestration: {
      state: overrides.orchestration?.state ?? "queued",
      owner: overrides.orchestration?.owner ?? null,
      runId: overrides.orchestration?.runId ?? null,
      leaseUntil: overrides.orchestration?.leaseUntil ?? null,
      reviewOutcome: overrides.orchestration?.reviewOutcome ?? "none",
      blockedReason: overrides.orchestration?.blockedReason ?? null,
      lastError: overrides.orchestration?.lastError ?? null,
      attemptCount: overrides.orchestration?.attemptCount ?? 0,
    },
  };
}

async function createTempPlanningRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "orq-local-planning-"));
}

async function seedIssues(root: string, records: WorkItemRecord[]): Promise<void> {
  await mkdirIfMissing(path.join(root, "issues"));

  for (const record of records) {
    await writeIssueFile(
      root,
      record.id,
      `${JSON.stringify(record, null, 2)}\n`,
    );
  }
}

async function writeIssueFile(
  root: string,
  issueId: string,
  contents: string,
): Promise<void> {
  await mkdirIfMissing(path.join(root, "issues"));
  await writeFile(path.join(root, "issues", `${issueId}.json`), contents, "utf8");
}

async function mkdirIfMissing(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true });
}
