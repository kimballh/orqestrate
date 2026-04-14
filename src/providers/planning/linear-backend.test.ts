import assert from "node:assert/strict";
import test from "node:test";

import { AuthenticationLinearError } from "@linear/sdk";

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

test("maps Linear issues into canonical work items and preserves dependency semantics", async () => {
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
        metadata: {
          harness_phase: "implement",
          harness_state: "waiting_human",
          harness_owner: "orchestrator-1",
          harness_run_id: "run-27",
          harness_lease_until: "2099-01-01T00:00:00.000Z",
          artifact_url: "https://notion.so/orq-27",
          review_outcome: "changes_requested",
          blocked_reason: "Waiting on ORQ-16",
          last_error: "Timed out waiting for GitHub",
          attempt_count: 2,
        },
      }),
    ]),
  );

  const workItem = await backend.getWorkItem("issue-27");

  assert.ok(workItem);
  assert.equal(workItem.status, "blocked");
  assert.equal(workItem.phase, "implement");
  assert.equal(workItem.parentId, "ORQ-9");
  assert.deepEqual(workItem.dependencyIds, ["ORQ-16", "ORQ-26"]);
  assert.deepEqual(workItem.blockedByIds, ["ORQ-16"]);
  assert.deepEqual(workItem.blocksIds, ["ORQ-28"]);
  assert.equal(workItem.artifactUrl, "https://notion.so/orq-27");
  assert.equal(workItem.orchestration.state, "waiting_human");
  assert.equal(workItem.orchestration.owner, "orchestrator-1");
  assert.equal(workItem.orchestration.runId, "run-27");
  assert.equal(workItem.orchestration.leaseUntil, "2099-01-01T00:00:00.000Z");
  assert.equal(workItem.orchestration.reviewOutcome, "changes_requested");
  assert.equal(workItem.orchestration.blockedReason, "Waiting on ORQ-16");
  assert.equal(workItem.orchestration.attemptCount, 2);
  assert.equal(
    workItem.orchestration.lastError?.message,
    "Timed out waiting for GitHub",
  );
});

test("lists actionable Linear work items with local-files parity filters and ordering", async () => {
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
        metadata: {
          harness_lease_until: "2099-01-01T00:00:00.000Z",
        },
      }),
      createFakeIssue({
        id: "issue-no-phase",
        identifier: "ORQ-21",
        title: "Review with no phase",
        state: workflowState("review"),
        priority: 1,
        updatedAt: "2026-04-13T09:00:00.000Z",
        metadata: {
          harness_phase: "none",
        },
      }),
      createFakeIssue({
        id: "issue-blocked",
        identifier: "ORQ-22",
        title: "Blocked implementation",
        state: workflowState("implement"),
        priority: 1,
        updatedAt: "2026-04-13T08:00:00.000Z",
        inverseRelations: [{ type: "blocks", issueId: "blocker-1" }],
      }),
      createFakeIssue({
        id: "issue-plan",
        identifier: "ORQ-23",
        title: "Plan work",
        state: workflowState("plan"),
        priority: 1,
        updatedAt: "2026-04-13T07:00:00.000Z",
      }),
      createFakeIssue({
        id: "issue-review",
        identifier: "ORQ-24",
        title: "Review work",
        state: workflowState("review"),
        priority: 1,
        updatedAt: "2026-04-13T11:00:00.000Z",
      }),
      createFakeIssue({
        id: "issue-implement",
        identifier: "ORQ-25",
        title: "Implementation work",
        state: workflowState("implement"),
        priority: 2,
        updatedAt: "2026-04-13T06:00:00.000Z",
      }),
    ]),
  );

  const actionable = await backend.listActionableWorkItems({ limit: 10 });
  assert.deepEqual(actionable.map((item) => item.identifier), [
    "ORQ-23",
    "ORQ-24",
    "ORQ-25",
  ]);

  const planOnly = await backend.listActionableWorkItems({
    limit: 10,
    phases: ["plan"],
  });
  assert.deepEqual(planOnly.map((item) => item.identifier), ["ORQ-23"]);

  const limited = await backend.listActionableWorkItems({ limit: 2 });
  assert.deepEqual(limited.map((item) => item.identifier), ["ORQ-23", "ORQ-24"]);
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
  const issuesById = new Map(issues.map((issue) => [issue.id, issue]));

  return {
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
      const issue = issuesById.get(id);

      if (!issue) {
        throw new Error(`Linear issue '${id}' was not found.`);
      }

      return buildFakeIssue(issue, issuesById);
    },
    issues: async (variables) => {
      const filtered = issues
        .filter((issue) => matchesIssueFilter(issue, variables?.filter))
        .sort(
          (left, right) =>
            Date.parse(left.updatedAt) - Date.parse(right.updatedAt),
        )
        .map((issue) => buildFakeIssue(issue, issuesById));

      return paginateArray(filtered, variables);
    },
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
    metadata: undefined,
    ...overrides,
  };
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
    metadata: issue.metadata,
    state: Promise.resolve(issue.state),
    parent: issue.parentId
      ? Promise.resolve(buildFakeIssue(issuesById.get(issue.parentId)!, issuesById))
      : undefined,
    labels: async (variables?: LinearConnectionVariables) =>
      paginateArray<LinearSdkIssueLabelLike>(issue.labels, variables),
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
  labels: LinearSdkIssueLabelLike[];
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
  metadata?: unknown;
};
