import assert from "node:assert/strict";
import test from "node:test";

import { AuthenticationLinearError, ForbiddenLinearError } from "@linear/sdk";

import type { PlanningLinearProviderConfig } from "../../config/types.js";

import {
  LinearPlanningClient,
  type LinearConnectionLike,
  type LinearConnectionVariables,
  type LinearSdkClientLike,
  type LinearSdkIssueLabelLike,
  type LinearSdkIssueLike,
  type LinearSdkIssueRelationLike,
  type LinearSdkProjectLike,
  type LinearSdkTeamLike,
  type LinearSdkViewerLike,
  type LinearSdkWorkflowStateLike,
} from "./linear/client.js";
import { upsertLinearDescriptionMachineState } from "./linear/machine-state/index.js";
import { LinearPlanningBackend } from "./linear-backend.js";

test("validates and resolves a scoped Linear backend adapter", async () => {
  const backend = createBackend(
    {
      team: "ORQ",
      project: "Orqestrate Build",
      mapping: {
        implement_status: "Building",
        review_status: "QA Review",
      },
    },
    createSdkClient({
      teams: [
        createSdkTeam({
          key: "ORQ",
          name: "Orqestrate",
          projects: [
            {
              id: "project-1",
              name: "Orqestrate Build",
              url: "https://linear.app/orqestrate/project/orqestrate-build",
            },
          ],
          states: createRequiredStates({
            implement: "Building",
            review: "QA Review",
          }),
        }),
      ],
    }),
  );

  await backend.validateConfig();

  const healthCheck = await backend.healthCheck();
  assert.deepEqual(healthCheck, {
    ok: true,
    message:
      "Connected to Linear team 'Orqestrate' and project 'Orqestrate Build'.",
  });

  const adapter = await backend.getConfigAdapter();
  const cachedAdapter = await backend.getConfigAdapter();

  assert.equal(cachedAdapter, adapter);
  assert.equal(adapter.team.key, "ORQ");
  assert.equal(adapter.project?.name, "Orqestrate Build");
  assert.equal(adapter.workflowStates.implement.name, "Building");
  assert.equal(adapter.workflowStates.review.name, "QA Review");
  assert.equal(adapter.viewer.name, "Kimball Hill");
});

test("rejects unsupported planning.linear mapping keys during validation", async () => {
  const backend = createBackend(
    {
      mapping: {
        ready_status: "Ready",
      } as PlanningLinearProviderConfig["mapping"],
    },
    createSdkClient(),
  );

  await assert.rejects(
    () => backend.validateConfig(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /unsupported planning\.linear mapping key/i);
      return true;
    },
  );
});

test("fails health checks clearly when the configured team cannot be found", async () => {
  const backend = createBackend(
    {
      team: "MISSING",
    },
    createSdkClient(),
  );

  const result = await backend.healthCheck();

  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /Linear team 'MISSING' was not found/i);
});

test("normalizes authentication failures into actionable health-check messages", async () => {
  const backend = createBackend(
    {},
    {
      viewer: Promise.reject(
        new AuthenticationLinearError({
          response: {
            status: 401,
            error: "Unauthorized",
          },
        } as never),
      ),
      teams: async () => ({ nodes: [] }),
    },
  );

  const result = await backend.healthCheck();

  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /configured api token/i);
});

test("maps Linear issues into canonical work items and defaults unresolved harness fields", async () => {
  const backend = createBackend(
    {},
    createIssueSdkClient([
      createFakeIssue({
        id: "issue-parent",
        identifier: "ORQ-9",
        title: "Parent stream",
        state: workflowState("plan"),
      }),
      createFakeIssue({
        id: "issue-blocker-open",
        identifier: "ORQ-16",
        title: "Active blocker",
        state: workflowState("plan"),
      }),
      createFakeIssue({
        id: "issue-blocker-done",
        identifier: "ORQ-26",
        title: "Finished blocker",
        state: workflowState("done"),
      }),
      createFakeIssue({
        id: "issue-downstream",
        identifier: "ORQ-28",
        title: "Downstream work",
        state: workflowState("backlog"),
      }),
      createFakeIssue({
        id: "issue-27",
        identifier: "ORQ-27",
        title: "Implement Linear canonical read mapping",
        description: "Hydrate Linear issues into canonical work items.",
        state: workflowState("blocked"),
        parentId: "issue-parent",
        priority: 2,
        labels: [{ id: "label-backend", name: "backend" }],
        relations: [{ type: "blocks", relatedIssueId: "issue-downstream" }],
        inverseRelations: [
          { type: "blocks", issueId: "issue-blocker-open" },
          { type: "blocks", issueId: "issue-blocker-done" },
        ],
      }),
    ]),
  );

  const workItem = await backend.getWorkItem("issue-27");

  assert.ok(workItem);
  assert.equal(workItem.status, "blocked");
  assert.equal(workItem.phase, "none");
  assert.equal(workItem.parentId, "ORQ-9");
  assert.deepEqual(workItem.dependencyIds, ["ORQ-16", "ORQ-26"]);
  assert.deepEqual(workItem.blockedByIds, ["ORQ-16"]);
  assert.deepEqual(workItem.blocksIds, ["ORQ-28"]);
  assert.equal(workItem.artifactUrl, null);
  assert.equal(workItem.orchestration.state, "idle");
  assert.equal(workItem.orchestration.owner, null);
  assert.equal(workItem.orchestration.runId, null);
  assert.equal(workItem.orchestration.leaseUntil, null);
  assert.equal(workItem.orchestration.reviewOutcome, "none");
  assert.equal(workItem.orchestration.blockedReason, null);
  assert.equal(workItem.orchestration.attemptCount, 0);
  assert.equal(workItem.orchestration.lastError, null);
});

test("lists actionable Linear issues via hybrid label and description machine state", async () => {
  const backend = createBackend(
    {},
    createIssueSdkClient([
      createFakeIssue({
        id: "blocker-1",
        identifier: "ORQ-10",
        title: "External blocker",
        state: workflowState("blocked"),
      }),
      createFakeIssue({
        id: "issue-leased",
        identifier: "ORQ-20",
        title: "Leased implementation",
        state: workflowState("implement"),
        priority: 1,
        updatedAt: "2026-04-13T10:00:00.000Z",
        labels: [
          { id: "label-phase-implement", name: "orq:phase:implement" },
          { id: "label-state-running", name: "orq:state:running" },
        ],
        description: withMachineState("Leased implementation details.", {
          owner: "worker-1",
          runId: "run-1",
          leaseUntil: "2999-04-13T10:30:00.000Z",
          artifactUrl: null,
          blockedReason: null,
          lastError: null,
          attemptCount: 2,
        }),
      }),
      createFakeIssue({
        id: "issue-no-phase",
        identifier: "ORQ-21",
        title: "Review with derived phase",
        state: workflowState("review"),
        priority: 1,
        updatedAt: "2026-04-13T09:00:00.000Z",
        description: "Human-authored review details.",
      }),
      createFakeIssue({
        id: "issue-blocked",
        identifier: "ORQ-22",
        title: "Blocked implementation",
        state: workflowState("implement"),
        priority: 1,
        updatedAt: "2026-04-13T08:00:00.000Z",
        inverseRelations: [{ type: "blocks", issueId: "blocker-1" }],
        labels: [{ id: "label-phase-implement-2", name: "orq:phase:implement" }],
      }),
      createFakeIssue({
        id: "issue-plan",
        identifier: "ORQ-23",
        title: "Plan work",
        state: workflowState("plan"),
        priority: 1,
        updatedAt: "2026-04-13T07:00:00.000Z",
        labels: [{ id: "label-state-queued", name: "orq:state:queued" }],
      }),
      createFakeIssue({
        id: "issue-review",
        identifier: "ORQ-24",
        title: "Review work",
        state: workflowState("review"),
        priority: 1,
        updatedAt: "2026-04-13T11:00:00.000Z",
        labels: [
          { id: "label-phase-review", name: "orq:phase:review" },
          { id: "label-state-queued-2", name: "orq:state:queued" },
        ],
        description: withMachineState("Review work details.", {
          owner: null,
          runId: null,
          leaseUntil: null,
          artifactUrl: "https://notion.so/review-24",
          blockedReason: null,
          lastError: null,
          attemptCount: 1,
        }),
      }),
      createFakeIssue({
        id: "issue-implement",
        identifier: "ORQ-25",
        title: "Implementation work",
        state: workflowState("implement"),
        priority: 2,
        updatedAt: "2026-04-13T06:00:00.000Z",
        labels: [{ id: "label-state-queued-3", name: "orq:state:queued" }],
      }),
    ]),
  );

  const records = await backend.listActionableWorkItems({ limit: 10 });

  assert.deepEqual(
    records.map((record) => record.identifier),
    ["ORQ-23", "ORQ-21", "ORQ-24", "ORQ-25"],
  );
  assert.equal(records[0]?.phase, "plan");
  assert.equal(records[1]?.phase, "review");
  assert.equal(records[1]?.description, "Human-authored review details.");
  assert.equal(records[2]?.artifactUrl, "https://notion.so/review-24");
  assert.equal(records[2]?.orchestration.attemptCount, 1);
});

test("preserves explicit phase labels for blocked issues", async () => {
  const backend = createBackend(
    {},
    createIssueSdkClient([
      createFakeIssue({
        id: "issue-53",
        identifier: "ORQ-53",
        title: "Blocked implementation still tracks phase",
        state: workflowState("blocked"),
        labels: [{ id: "label-phase-implement", name: "orq:phase:implement" }],
      }),
    ]),
  );

  const workItem = await backend.getWorkItem("issue-53");

  assert.ok(workItem);
  assert.equal(workItem.status, "blocked");
  assert.equal(workItem.phase, "implement");
});

test("fails closed when a candidate issue contains malformed machine-state data", async () => {
  const backend = createBackend(
    {},
    createIssueSdkClient([
      createFakeIssue({
        id: "issue-54",
        identifier: "ORQ-54",
        title: "Malformed machine state",
        state: workflowState("implement"),
        labels: [
          { id: "label-phase-implement", name: "orq:phase:implement" },
          { id: "label-phase-review", name: "orq:phase:review" },
        ],
      }),
    ]),
  );

  await assert.rejects(
    () => backend.listActionableWorkItems({ limit: 10 }),
    /malformed machine-owned state/i,
  );
});

test("claims Linear issues while preserving human labels and description text", async () => {
  const harness = createMutableIssueSdkHarness([
    createFakeIssue({
      id: "issue-28",
      identifier: "ORQ-28",
      title: "Implement Linear mutations",
      state: workflowState("implement"),
      labels: [{ id: "label-backend", name: "backend" }],
      description: withMachineState("Implement the write path.", {
        owner: null,
        runId: null,
        leaseUntil: null,
        artifactUrl: "https://notion.so/orq-28",
        blockedReason: "stale blocker",
        lastError: {
          providerFamily: "planning",
          providerKind: "planning.linear",
          code: "validation",
          message: "stale machine state",
          retryable: false,
          details: null,
        },
        attemptCount: 0,
      }),
    }),
  ]);
  const backend = createBackend({}, harness.sdkClient);

  const claimed = await backend.claimWorkItem({
    id: "issue-28",
    phase: "implement",
    owner: "orchestrator-1",
    runId: "run-28",
    leaseUntil: "2099-04-14T01:00:00.000Z",
  });

  assert.equal(claimed.orchestration.state, "claimed");
  assert.equal(claimed.orchestration.owner, "orchestrator-1");
  assert.equal(claimed.orchestration.runId, "run-28");
  assert.equal(claimed.orchestration.leaseUntil, "2099-04-14T01:00:00.000Z");
  assert.equal(claimed.orchestration.blockedReason, null);
  assert.equal(claimed.orchestration.lastError, null);
  assert.equal(claimed.orchestration.attemptCount, 1);
  assert.equal(claimed.artifactUrl, "https://notion.so/orq-28");
  assert.equal(claimed.description, "Implement the write path.");
  assert.deepEqual(claimed.labels.sort(), [
    "backend",
    "orq:phase:implement",
    "orq:review:none",
    "orq:state:claimed",
  ]);
  assert.deepEqual(harness.createdLabelNames.sort(), [
    "orq:phase:implement",
    "orq:review:none",
    "orq:state:claimed",
  ]);
});

test("reuses attached global provider-owned labels without trying to recreate them", async () => {
  const harness = createMutableIssueSdkHarness(
    [
      createFakeIssue({
        id: "issue-global-labels",
        identifier: "ORQ-82",
        title: "Global provider labels",
        state: workflowState("implement"),
        labels: [
          { id: "label-global-phase", name: "orq:phase:implement", teamId: undefined },
          { id: "label-global-state", name: "orq:state:idle", teamId: undefined },
          { id: "label-global-review", name: "orq:review:none", teamId: undefined },
        ],
      }),
    ],
    {
      createIssueLabelError: new ForbiddenLinearError({
        response: {
          status: 403,
          error: "Forbidden",
        },
      } as never),
      extraLabels: [
        {
          id: "label-global-claimed",
          name: "orq:state:claimed",
          teamId: null,
          archivedAt: null,
        },
      ],
    },
  );
  const backend = createBackend({}, harness.sdkClient);

  const claimed = await backend.claimWorkItem({
    id: "issue-global-labels",
    phase: "implement",
    owner: "orchestrator-1",
    runId: "run-82",
    leaseUntil: "2099-04-14T01:00:00.000Z",
  });

  assert.equal(claimed.orchestration.state, "claimed");
  assert.deepEqual(harness.createdLabelNames, []);
});

test("rejects invalid claims for phase mismatches, blockers, and active leases", async () => {
  const backend = createBackend(
    {},
    createIssueSdkClient([
      createFakeIssue({
        id: "issue-blocked-claim",
        identifier: "ORQ-60",
        title: "Blocked claim",
        state: workflowState("implement"),
        inverseRelations: [{ type: "blocks", issueId: "issue-blocker-open" }],
      }),
      createFakeIssue({
        id: "issue-blocker-open",
        identifier: "ORQ-61",
        title: "Open blocker",
        state: workflowState("plan"),
      }),
      createFakeIssue({
        id: "issue-phase-mismatch",
        identifier: "ORQ-62",
        title: "Phase mismatch",
        state: workflowState("plan"),
      }),
      createFakeIssue({
        id: "issue-lease-active",
        identifier: "ORQ-63",
        title: "Leased issue",
        state: workflowState("implement"),
        labels: [
          { id: "label-phase-implement", name: "orq:phase:implement" },
          { id: "label-state-claimed", name: "orq:state:claimed" },
        ],
        description: withMachineState("Leased issue.", {
          owner: "orchestrator-1",
          runId: "run-active",
          leaseUntil: "2099-04-14T01:05:00.000Z",
          artifactUrl: null,
          blockedReason: null,
          lastError: null,
          attemptCount: 1,
        }),
      }),
    ]),
  );

  await assert.rejects(
    () =>
      backend.claimWorkItem({
        id: "issue-phase-mismatch",
        phase: "implement",
        owner: "orchestrator-1",
        runId: "run-phase",
        leaseUntil: "2099-04-14T01:00:00.000Z",
      }),
    /phase 'plan', not 'implement'/i,
  );

  await assert.rejects(
    () =>
      backend.claimWorkItem({
        id: "issue-blocked-claim",
        phase: "implement",
        owner: "orchestrator-1",
        runId: "run-blocked",
        leaseUntil: "2099-04-14T01:00:00.000Z",
      }),
    /open blockers/i,
  );

  await assert.rejects(
    () =>
      backend.claimWorkItem({
        id: "issue-lease-active",
        phase: "implement",
        owner: "orchestrator-2",
        runId: "run-lease",
        leaseUntil: "2099-04-14T01:00:00.000Z",
      }),
    /active lease/i,
  );
});

test("enforces ownership for running and lease renewal updates", async () => {
  const harness = createMutableIssueSdkHarness([
    createFakeIssue({
      id: "issue-64",
      identifier: "ORQ-64",
      title: "Lease ownership",
      state: workflowState("implement"),
      labels: [
        { id: "label-phase-implement", name: "orq:phase:implement" },
        { id: "label-state-claimed", name: "orq:state:claimed" },
        { id: "label-review-none", name: "orq:review:none" },
      ],
      description: withMachineState("Claimed implementation.", {
        owner: "orchestrator-1",
        runId: "run-64",
        leaseUntil: "2099-04-14T01:00:00.000Z",
        artifactUrl: null,
        blockedReason: null,
        lastError: null,
        attemptCount: 2,
      }),
    }),
  ]);
  const backend = createBackend({}, harness.sdkClient);

  await assert.rejects(
    () =>
      backend.markWorkItemRunning({
        id: "issue-64",
        owner: "orchestrator-2",
        runId: "run-64",
        leaseUntil: "2099-04-14T01:05:00.000Z",
      }),
    /owned by/i,
  );

  const running = await backend.markWorkItemRunning({
    id: "issue-64",
    owner: "orchestrator-1",
    runId: "run-64",
    leaseUntil: "2099-04-14T01:05:00.000Z",
  });

  assert.equal(running.orchestration.state, "running");
  assert.equal(running.orchestration.leaseUntil, "2099-04-14T01:05:00.000Z");

  await assert.rejects(
    () =>
      backend.renewLease({
        id: "issue-64",
        owner: "orchestrator-1",
        runId: "run-other",
        leaseUntil: "2099-04-14T01:10:00.000Z",
      }),
    /leased to run/i,
  );

  const renewed = await backend.renewLease({
    id: "issue-64",
    owner: "orchestrator-1",
    runId: "run-64",
    leaseUntil: "2099-04-14T01:10:00.000Z",
  });

  assert.equal(renewed.orchestration.leaseUntil, "2099-04-14T01:10:00.000Z");
  assert.equal(renewed.orchestration.state, "running");
});

test("preserves blocked phases and clears terminal phases on Linear transitions", async () => {
  const harness = createMutableIssueSdkHarness([
    createFakeIssue({
      id: "issue-70",
      identifier: "ORQ-70",
      title: "Blocked implementation",
      state: workflowState("implement"),
      labels: [
        { id: "label-phase-implement", name: "orq:phase:implement" },
        { id: "label-state-running", name: "orq:state:running" },
        { id: "label-review-none", name: "orq:review:none" },
      ],
      description: withMachineState("Implementation details.", {
        owner: "orchestrator-1",
        runId: "run-70",
        leaseUntil: "2099-04-14T01:00:00.000Z",
        artifactUrl: null,
        blockedReason: null,
        lastError: null,
        attemptCount: 2,
      }),
    }),
    createFakeIssue({
      id: "issue-71",
      identifier: "ORQ-71",
      title: "Completed review",
      state: workflowState("review"),
      labels: [
        { id: "label-phase-review", name: "orq:phase:review" },
        { id: "label-state-running-review", name: "orq:state:running" },
        { id: "label-review-cr", name: "orq:review:changes_requested" },
      ],
      description: withMachineState("Review details.", {
        owner: "reviewer-1",
        runId: "run-71",
        leaseUntil: "2099-04-14T01:05:00.000Z",
        artifactUrl: null,
        blockedReason: null,
        lastError: null,
        attemptCount: 3,
      }),
    }),
    createFakeIssue({
      id: "issue-72",
      identifier: "ORQ-72",
      title: "Move into review",
      state: workflowState("implement"),
      labels: [
        { id: "label-phase-implement-72", name: "orq:phase:implement" },
        { id: "label-state-completed-72", name: "orq:state:completed" },
        { id: "label-review-cr-72", name: "orq:review:changes_requested" },
      ],
      description: withMachineState("Implementation done.", {
        owner: null,
        runId: "run-72",
        leaseUntil: null,
        artifactUrl: null,
        blockedReason: null,
        lastError: null,
        attemptCount: 2,
      }),
    }),
  ]);
  const backend = createBackend({}, harness.sdkClient);

  const blocked = await backend.transitionWorkItem({
    id: "issue-70",
    nextStatus: "blocked",
    nextPhase: "none",
    state: "waiting_human",
    blockedReason: "missing credentials",
    runId: "run-70",
  });

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.phase, "implement");
  assert.equal(blocked.orchestration.owner, null);
  assert.equal(blocked.orchestration.leaseUntil, null);
  assert.equal(blocked.orchestration.blockedReason, "missing credentials");

  const done = await backend.transitionWorkItem({
    id: "issue-71",
    nextStatus: "done",
    nextPhase: "none",
    state: "completed",
    runId: "run-71",
  });

  assert.equal(done.phase, "none");
  assert.equal(done.orchestration.owner, null);
  assert.equal(done.orchestration.leaseUntil, null);
  assert.equal(done.orchestration.reviewOutcome, "none");
  assert.equal(done.orchestration.attemptCount, 0);

  const movedToReview = await backend.transitionWorkItem({
    id: "issue-72",
    nextStatus: "review",
    nextPhase: "review",
    state: "completed",
    runId: "run-72",
  });

  assert.equal(movedToReview.phase, "review");
  assert.equal(movedToReview.orchestration.reviewOutcome, "none");
  assert.equal(movedToReview.orchestration.attemptCount, 0);
});

test("creates explicit Linear comments through the planning backend", async () => {
  const harness = createMutableIssueSdkHarness([
    createFakeIssue({
      id: "issue-80",
      identifier: "ORQ-80",
      title: "Comment target",
      state: workflowState("plan"),
    }),
  ]);
  const backend = createBackend({}, harness.sdkClient);

  await backend.appendComment({
    id: "issue-80",
    body: "Implemented claim + transition writes.",
  });

  assert.deepEqual(harness.comments, [
    {
      issueId: "issue-80",
      body: "Implemented claim + transition writes.",
    },
  ]);
});

test("preserves comment bodies verbatim when forwarding to Linear", async () => {
  const harness = createMutableIssueSdkHarness([
    createFakeIssue({
      id: "issue-80b",
      identifier: "ORQ-80B",
      title: "Comment formatting target",
      state: workflowState("plan"),
    }),
  ]);
  const backend = createBackend({}, harness.sdkClient);
  const body = "  line one\n\n  indented line two  ";

  await backend.appendComment({
    id: "issue-80b",
    body,
  });

  assert.deepEqual(harness.comments, [
    {
      issueId: "issue-80b",
      body,
    },
  ]);
});

test("surfaces provider label-creation permission failures clearly", async () => {
  const harness = createMutableIssueSdkHarness(
    [
      createFakeIssue({
        id: "issue-81",
        identifier: "ORQ-81",
        title: "Label creation failure",
        state: workflowState("implement"),
      }),
    ],
    {
      createIssueLabelError: new ForbiddenLinearError({
        response: {
          status: 403,
          error: "Forbidden",
        },
      } as never),
    },
  );
  const backend = createBackend({}, harness.sdkClient);

  await assert.rejects(
    () =>
      backend.claimWorkItem({
        id: "issue-81",
        phase: "implement",
        owner: "orchestrator-1",
        runId: "run-81",
        leaseUntil: "2099-04-14T01:00:00.000Z",
      }),
    /do not have permission/i,
  );
});

test("returns null for missing issues and builds deep links from the hydrated issue url", async () => {
  const backend = createBackend(
    {},
    createIssueSdkClient([
      createFakeIssue({
        id: "issue-1",
        identifier: "ORQ-30",
        title: "Deep link source",
        state: workflowState("implement"),
        url: "https://linear.app/orqestrate/issue/ORQ-30/deep-link-source",
      }),
    ]),
  );

  assert.equal(await backend.getWorkItem("missing-issue"), null);
  assert.equal(await backend.buildDeepLink("missing-issue"), null);
  assert.equal(
    await backend.buildDeepLink("issue-1"),
    "https://linear.app/orqestrate/issue/ORQ-30/deep-link-source",
  );
});

function createBackend(
  overrides: Partial<PlanningLinearProviderConfig>,
  sdkClient: LinearSdkClientLike,
) {
  return new LinearPlanningBackend(
    {
      name: "linear_main",
      family: "planning",
      kind: "planning.linear",
      tokenEnv: "LINEAR_API_KEY",
      team: "ORQ",
      mapping: {},
      ...overrides,
    },
    {
      client: new LinearPlanningClient({
        sdkClient,
      }),
    },
  );
}

function createSdkClient(options: {
  viewer?: LinearSdkViewerLike;
  teams?: LinearSdkTeamLike[];
} = {}): LinearSdkClientLike {
  return {
    viewer: Promise.resolve(
      options.viewer ?? {
        id: "viewer-1",
        name: "Kimball Hill",
        displayName: "Kimball Hill",
        email: "kimball@example.com",
      },
    ),
    teams: async () => ({
      nodes:
        options.teams ??
        [
          createSdkTeam({
            key: "ENG",
            name: "Engineering",
            states: createRequiredStates(),
          }),
        ],
    }),
  };
}

function createIssueSdkClient(
  issues: FakeIssueDefinition[],
): LinearSdkClientLike {
  return createMutableIssueSdkHarness(issues).sdkClient;
}

function createMutableIssueSdkHarness(
  issues: FakeIssueDefinition[],
  options: {
    createIssueLabelError?: Error;
    extraLabels?: FakeLabelDefinition[];
  } = {},
): {
  sdkClient: LinearSdkClientLike;
  comments: Array<{ issueId: string; body: string }>;
  createdLabelNames: string[];
} {
  const mutableIssues = new Map(
    issues.map((issue) => [issue.id, structuredClone(issue)] as const),
  );
  const labelsById = new Map<string, FakeLabelDefinition>();
  const comments: Array<{ issueId: string; body: string }> = [];
  const createdLabelNames: string[] = [];
  let mutationCounter = 0;

  for (const issue of mutableIssues.values()) {
    for (const label of issue.labels) {
      labelsById.set(label.id, {
        id: label.id,
        name: label.name,
        teamId:
          Object.prototype.hasOwnProperty.call(label, "teamId")
            ? label.teamId ?? null
            : "team-orq",
        archivedAt: null,
      });
    }
  }

  for (const label of options.extraLabels ?? []) {
    labelsById.set(label.id, structuredClone(label));
  }

  const workflowStatesById = new Map(
    createRequiredStates().map((state) => [state.id, state] as const),
  );

  const sdkClient: LinearSdkClientLike = {
    ...createSdkClient({
      teams: [
        createSdkTeam({
          key: "ORQ",
          name: "Orqestrate",
          projects: [
            {
              id: "project-1",
              name: "Orqestrate Build",
              url: "https://linear.app/orqestrate/project/orqestrate-build",
            },
          ],
          states: createRequiredStates(),
        }),
      ],
    }),
    issue: async (id) => {
      const issue = mutableIssues.get(id);

      if (!issue) {
        throw new Error(`Linear issue '${id}' was not found.`);
      }

      return buildFakeIssue(issue, mutableIssues);
    },
    issues: async (variables) => {
      const filtered = [...mutableIssues.values()]
        .filter((issue) => matchesIssueFilter(issue, variables?.filter))
        .sort(
          (left, right) =>
            Date.parse(left.updatedAt) - Date.parse(right.updatedAt),
        )
        .map((issue) => buildFakeIssue(issue, mutableIssues));

      return paginateArray(filtered, variables);
    },
    updateIssue: async (id, input) => {
      const issue = mutableIssues.get(id);

      if (!issue) {
        throw new Error(`Linear issue '${id}' was not found.`);
      }

      if (input.stateId) {
        const nextState = workflowStatesById.get(input.stateId);

        if (!nextState) {
          throw new Error(`Unknown workflow state '${input.stateId}'.`);
        }

        issue.state = nextState;
      }

      if (input.labelIds) {
        issue.labels = input.labelIds.map((labelId) => {
          const label = labelsById.get(labelId);

          if (!label) {
            throw new Error(`Unknown issue label '${labelId}'.`);
          }

          return {
            id: label.id,
            name: label.name,
            teamId: label.teamId ?? undefined,
          };
        });
      }

      if (Object.prototype.hasOwnProperty.call(input, "description")) {
        issue.description = input.description ?? null;
      }

      mutationCounter += 1;
      issue.updatedAt = `2026-04-14T00:00:${String(mutationCounter).padStart(2, "0")}.000Z`;

      return { success: true };
    },
    createComment: async (input) => {
      comments.push({
        issueId: input.issueId ?? "",
        body: input.body ?? "",
      });

      return { success: true };
    },
    issueLabels: async () =>
      paginateArray(
        [...labelsById.values()].map((label) => ({
          id: label.id,
          name: label.name,
          teamId: label.teamId ?? undefined,
          archivedAt: label.archivedAt,
        })),
      ),
    createIssueLabel: async (input) => {
      if (options.createIssueLabelError) {
        throw options.createIssueLabelError;
      }

      const normalizedName = input.name.trim().toLowerCase();
      const existing = [...labelsById.values()].find(
        (label) => label.name.trim().toLowerCase() === normalizedName,
      );

      if (existing) {
        return {
          success: true,
          issueLabel: Promise.resolve({
            id: existing.id,
            name: existing.name,
            teamId: existing.teamId ?? undefined,
            archivedAt: existing.archivedAt,
          }),
        };
      }

      const createdLabel = {
        id: `label-created-${labelsById.size + 1}`,
        name: input.name,
        teamId: input.teamId ?? null,
        archivedAt: null,
      } satisfies FakeLabelDefinition;
      labelsById.set(createdLabel.id, createdLabel);
      createdLabelNames.push(createdLabel.name);

      return {
        success: true,
        issueLabel: Promise.resolve({
          id: createdLabel.id,
          name: createdLabel.name,
          teamId: createdLabel.teamId ?? undefined,
          archivedAt: createdLabel.archivedAt,
        }),
      };
    },
  };

  return {
    sdkClient,
    comments,
    createdLabelNames,
  };
}

function createSdkTeam(options: {
  id?: string;
  key: string;
  name: string;
  displayName?: string;
  projects?: LinearSdkProjectLike[];
  states?: LinearSdkWorkflowStateLike[];
}): LinearSdkTeamLike {
  return {
    id: options.id ?? `team-${options.key.toLowerCase()}`,
    key: options.key,
    name: options.name,
    displayName: options.displayName ?? options.name,
    projects: async () => ({
      nodes: options.projects ?? [],
    }),
    states: async () => ({
      nodes: options.states ?? createRequiredStates(),
    }),
  };
}

function createFakeIssue(
  overrides: Partial<FakeIssueDefinition> & Pick<FakeIssueDefinition, "id" | "identifier" | "title" | "state">,
): FakeIssueDefinition {
  return {
    description: null,
    priority: 0,
    createdAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
    url: `https://linear.app/orqestrate/issue/${overrides.identifier.toLowerCase()}`,
    teamId: "team-orq",
    projectId: "project-1",
    labels: [],
    relations: [],
    inverseRelations: [],
    ...overrides,
  };
}

function withMachineState(
  description: string,
  machineState: Parameters<typeof upsertLinearDescriptionMachineState>[1],
): string {
  return upsertLinearDescriptionMachineState(description, machineState);
}

function createRequiredStates(
  overrides: Partial<Record<RequiredStateName, string>> = {},
): LinearSdkWorkflowStateLike[] {
  const names: Record<RequiredStateName, string> = {
    backlog: "Backlog",
    design: "Design",
    plan: "Plan",
    implement: "Implement",
    review: "Review",
    blocked: "Blocked",
    done: "Done",
    canceled: "Canceled",
    ...overrides,
  };

  return (Object.entries(names) as Array<[RequiredStateName, string]>).map(
    ([stateName, displayName]) => ({
      id: `state-${stateName}`,
      name: displayName,
      type: stateName,
      teamId: "team-orq",
      archivedAt: null,
    }),
  );
}

function workflowState(name: RequiredStateName): LinearSdkWorkflowStateLike {
  return createRequiredStates().find((state) => state.type === name)!;
}

function buildFakeIssue(
  issue: FakeIssueDefinition,
  issuesById: Map<string, FakeIssueDefinition>,
): LinearSdkIssueLike {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    url: issue.url,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    teamId: issue.teamId,
    projectId: issue.projectId ?? undefined,
    state: Promise.resolve(issue.state),
    parent: issue.parentId
      ? Promise.resolve(buildFakeIssue(issuesById.get(issue.parentId)!, issuesById))
      : undefined,
    labels: async (variables?: LinearConnectionVariables) =>
      paginateArray<LinearSdkIssueLabelLike>(
        issue.labels.map((label) => ({
          id: label.id,
          name: label.name,
          teamId: label.teamId ?? undefined,
        })),
        variables,
      ),
    relations: async (variables?: LinearConnectionVariables) =>
      paginateArray<LinearSdkIssueRelationLike>(
        issue.relations.map((relation, index) =>
          buildFakeRelation({
            id:
              relation.id ??
              `${issue.id}:relation:${relation.relatedIssueId}:${index}`,
            type: relation.type,
            issueId: issue.id,
            relatedIssueId: relation.relatedIssueId,
          }, issuesById),
        ),
        variables,
      ),
    inverseRelations: async (variables?: LinearConnectionVariables) =>
      paginateArray<LinearSdkIssueRelationLike>(
        issue.inverseRelations.map((relation, index) =>
          buildFakeRelation({
            id:
              relation.id ??
              `${relation.issueId}:inverse:${issue.id}:${index}`,
            type: relation.type,
            issueId: relation.issueId,
            relatedIssueId: issue.id,
          }, issuesById),
        ),
        variables,
      ),
  };
}

function buildFakeRelation(
  relation: {
    id: string;
    type: string;
    issueId: string;
    relatedIssueId: string;
  },
  issuesById: Map<string, FakeIssueDefinition>,
): LinearSdkIssueRelationLike {
  return {
    id: relation.id,
    type: relation.type,
    issueId: relation.issueId,
    relatedIssueId: relation.relatedIssueId,
    issue: Promise.resolve(
      buildFakeIssue(issuesById.get(relation.issueId)!, issuesById),
    ),
    relatedIssue: Promise.resolve(
      buildFakeIssue(issuesById.get(relation.relatedIssueId)!, issuesById),
    ),
  };
}

function paginateArray<T>(
  values: T[],
  variables?: {
    after?: string;
    first?: number;
  },
): LinearConnectionLike<T> {
  const start = variables?.after ? Number.parseInt(variables.after, 10) + 1 : 0;
  const first = variables?.first ?? values.length;
  const nodes = values.slice(start, start + first);
  const endIndex = start + nodes.length - 1;

  return {
    nodes,
    pageInfo: {
      hasNextPage: endIndex < values.length - 1,
      endCursor: nodes.length === 0 ? null : String(endIndex),
    },
  };
}

function matchesIssueFilter(issue: FakeIssueDefinition, filter: unknown): boolean {
  if (!isRecord(filter)) {
    return true;
  }

  const teamId = readNestedString(filter, ["team", "id", "eq"]);
  if (teamId !== null && issue.teamId !== teamId) {
    return false;
  }

  const projectId = readNestedString(filter, ["project", "id", "eq"]);
  if (projectId !== null && issue.projectId !== projectId) {
    return false;
  }

  const stateIds = readNestedStringArray(filter, ["state", "id", "in"]);
  if (stateIds !== null && !stateIds.includes(issue.state.id)) {
    return false;
  }

  return true;
}

function readNestedString(
  source: Record<string, unknown>,
  path: string[],
): string | null {
  const value = path.reduce<unknown>(
    (current, key) => (isRecord(current) ? current[key] : undefined),
    source,
  );

  return typeof value === "string" ? value : null;
}

function readNestedStringArray(
  source: Record<string, unknown>,
  path: string[],
): string[] | null {
  const value = path.reduce<unknown>(
    (current, key) => (isRecord(current) ? current[key] : undefined),
    source,
  );

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return null;
  }

  return value as string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type RequiredStateName =
  | "backlog"
  | "design"
  | "plan"
  | "implement"
  | "review"
  | "blocked"
  | "done"
  | "canceled";

type FakeIssueDefinition = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: LinearSdkWorkflowStateLike;
  priority: number;
  createdAt: string;
  updatedAt: string;
  url: string;
  teamId: string;
  projectId: string | null;
  parentId?: string;
  labels: Array<{
    id: string;
    name: string;
    teamId?: string | null;
  }>;
  relations: Array<{
    id?: string;
    type: string;
    relatedIssueId: string;
  }>;
  inverseRelations: Array<{
    id?: string;
    type: string;
    issueId: string;
  }>;
};

type FakeLabelDefinition = {
  id: string;
  name: string;
  teamId: string | null;
  archivedAt: string | null;
};
