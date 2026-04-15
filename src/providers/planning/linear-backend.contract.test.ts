import type { PlanningLinearProviderConfig } from "../../config/types.js";
import type { WorkItemRecord } from "../../domain-model.js";
import { definePlanningBackendContract } from "../../test/contracts/planning-backend-contract.js";

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
import { buildLinearMachineStateLabelNames } from "./linear/machine-state/label-binding.js";
import { upsertLinearDescriptionMachineState } from "./linear/machine-state/index.js";
import { LinearPlanningBackend } from "./linear-backend.js";

definePlanningBackendContract({
  providerName: "planning.linear",
  async setup(input) {
    const harness = createMutableIssueSdkHarness(
      input.workItems.map((workItem) => createFakeIssueFromWorkItem(workItem)),
    );

    const backend = createBackend({}, harness.sdkClient);
    await backend.validateConfig();

    return {
      backend,
      async getCommentBodies() {
        return harness.comments.map((comment) => comment.body);
      },
      getExpectedDeepLink(workItemId) {
        return harness.issueUrls.get(workItemId) ?? null;
      },
    };
  },
});

type FakeLabelDefinition = {
  id: string;
  name: string;
  teamId?: string | null;
  archivedAt?: string | null;
};

type FakeIssueDefinition = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  url: string | null;
  createdAt: string;
  updatedAt: string;
  teamId: string;
  projectId: string | null;
  state: LinearSdkWorkflowStateLike;
  parentId?: string;
  labels: Array<{
    id: string;
    name: string;
    teamId?: string | null;
  }>;
  relations: Array<{
    id: string;
    type: string;
    relatedIssueId: string;
  }>;
  inverseRelations: Array<{
    id: string;
    type: string;
    issueId: string;
  }>;
};

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

function createMutableIssueSdkHarness(
  issues: FakeIssueDefinition[],
): {
  sdkClient: LinearSdkClientLike;
  comments: Array<{ issueId: string; body: string }>;
  issueUrls: Map<string, string | null>;
} {
  const mutableIssues = new Map(
    issues.map((issue) => [issue.id, structuredClone(issue)] as const),
  );
  const labelsById = new Map<string, FakeLabelDefinition>();
  const comments: Array<{ issueId: string; body: string }> = [];
  const issueUrls = new Map<string, string | null>();
  let mutationCounter = 0;

  for (const issue of mutableIssues.values()) {
    issueUrls.set(issue.id, issue.url);
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

  const workflowStatesById = new Map(
    createRequiredStates().map((state) => [state.id, state] as const),
  );

  const sdkClient: LinearSdkClientLike = {
    viewer: Promise.resolve({
      id: "viewer-1",
      name: "Kimball Hill",
      displayName: "Kimball Hill",
      email: "kimball@example.com",
    } satisfies LinearSdkViewerLike),
    teams: async () => ({
      nodes: [
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
    issues: async () =>
      paginateArray(
        [...mutableIssues.values()]
          .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
          .map((issue) => buildFakeIssue(issue, mutableIssues)),
      ),
    updateIssue: async (id, input) => {
      const issue = mutableIssues.get(id);

      if (!issue) {
        throw new Error(`Linear issue '${id}' was not found.`);
      }

      if (input.stateId !== undefined) {
        const nextState = workflowStatesById.get(input.stateId);

        if (nextState === undefined) {
          throw new Error(`Unknown workflow state '${input.stateId}'.`);
        }

        issue.state = nextState;
      }

      if (input.labelIds !== undefined) {
        issue.labels = input.labelIds.map((labelId) => {
          const label = labelsById.get(labelId);

          if (label === undefined) {
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
      const normalizedName = input.name.trim().toLowerCase();
      const existing = [...labelsById.values()].find(
        (label) => label.name.trim().toLowerCase() === normalizedName,
      );

      if (existing !== undefined) {
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

      const createdLabel: FakeLabelDefinition = {
        id: `label-created-${labelsById.size + 1}`,
        name: input.name,
        teamId: input.teamId ?? null,
        archivedAt: null,
      };
      labelsById.set(createdLabel.id, createdLabel);

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
    issueUrls,
  };
}

function createFakeIssueFromWorkItem(workItem: WorkItemRecord): FakeIssueDefinition {
  const providerLabels = buildLinearMachineStateLabelNames({
    phase: workItem.phase,
    state: workItem.orchestration.state,
    reviewOutcome: workItem.orchestration.reviewOutcome ?? "none",
  });
  const labels = [...workItem.labels, ...providerLabels].map((name, index) => ({
    id: `${workItem.id}:label:${index + 1}`,
    name,
  }));

  return {
    id: workItem.id,
    identifier: workItem.identifier ?? workItem.id,
    title: workItem.title,
    description: upsertLinearDescriptionMachineState(workItem.description ?? "", {
      owner: workItem.orchestration.owner ?? null,
      runId: workItem.orchestration.runId ?? null,
      leaseUntil: workItem.orchestration.leaseUntil ?? null,
      artifactUrl: workItem.artifactUrl ?? null,
      blockedReason: workItem.orchestration.blockedReason ?? null,
      lastError: workItem.orchestration.lastError ?? null,
      attemptCount: workItem.orchestration.attemptCount,
    }),
    priority: workItem.priority ?? 0,
    url: workItem.url ?? null,
    createdAt: workItem.createdAt ?? "2026-04-13T00:00:00.000Z",
    updatedAt: workItem.updatedAt,
    teamId: "team-orq",
    projectId: "project-1",
    state: workflowState(workItem.status),
    labels,
    relations: workItem.blocksIds.map((relatedIssueId, index) => ({
      id: `${workItem.id}:relation:${relatedIssueId}:${index}`,
      type: "blocks",
      relatedIssueId,
    })),
    inverseRelations: workItem.blockedByIds.map((issueId, index) => ({
      id: `${issueId}:inverse:${workItem.id}:${index}`,
      type: "blocks",
      issueId,
    })),
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

function createRequiredStates(): LinearSdkWorkflowStateLike[] {
  return [
    createWorkflowState("backlog", "Backlog"),
    createWorkflowState("design", "Design"),
    createWorkflowState("plan", "Plan"),
    createWorkflowState("implement", "Implement"),
    createWorkflowState("review", "Review"),
    createWorkflowState("blocked", "Blocked"),
    createWorkflowState("done", "Done"),
    createWorkflowState("canceled", "Canceled"),
  ];
}

function createWorkflowState(type: string, name: string): LinearSdkWorkflowStateLike {
  return {
    id: `state-${type}`,
    name,
    type,
    teamId: "team-orq",
    archivedAt: null,
  };
}

function workflowState(status: WorkItemRecord["status"]): LinearSdkWorkflowStateLike {
  return (
    createRequiredStates().find((state) => state.type === status) ??
    createWorkflowState(status, status)
  );
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
        issue.relations.map((relation) =>
          buildFakeRelation(
            {
              id: relation.id,
              type: relation.type,
              issueId: issue.id,
              relatedIssueId: relation.relatedIssueId,
            },
            issuesById,
          ),
        ),
        variables,
      ),
    inverseRelations: async (variables?: LinearConnectionVariables) =>
      paginateArray<LinearSdkIssueRelationLike>(
        issue.inverseRelations.map((relation) =>
          buildFakeRelation(
            {
              id: relation.id,
              type: relation.type,
              issueId: relation.issueId,
              relatedIssueId: issue.id,
            },
            issuesById,
          ),
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
    issue: Promise.resolve(buildFakeIssue(issuesById.get(relation.issueId)!, issuesById)),
    relatedIssue: Promise.resolve(
      buildFakeIssue(issuesById.get(relation.relatedIssueId)!, issuesById),
    ),
  };
}

function paginateArray<TNode>(
  nodes: TNode[],
  variables?: LinearConnectionVariables,
): LinearConnectionLike<TNode> {
  const pageSize = variables?.first ?? nodes.length;
  const startIndex =
    variables?.after === undefined
      ? 0
      : Number.parseInt(variables.after, 10) || 0;
  const page = nodes.slice(startIndex, startIndex + pageSize);
  const nextIndex = startIndex + page.length;

  return {
    nodes: page,
    pageInfo: {
      hasNextPage: nextIndex < nodes.length,
      endCursor: nextIndex < nodes.length ? String(nextIndex) : null,
    },
  };
}
