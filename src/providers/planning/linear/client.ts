import { LinearClient as LinearSdkClient } from "@linear/sdk";

import { LinearProviderFailure } from "./errors.js";

type Awaitable<T> = Promise<T> | PromiseLike<T>;

export type LinearConnectionLike<TNode> = {
  nodes: TNode[];
  pageInfo?: {
    hasNextPage: boolean;
    endCursor?: string | null;
  };
};

export interface LinearSdkViewerLike {
  id: string;
  name: string;
  displayName?: string | null;
  email?: string | null;
}

export interface LinearSdkProjectLike {
  id: string;
  name: string;
  url?: string | null;
}

export interface LinearSdkWorkflowStateLike {
  id: string;
  name: string;
  type: string;
  teamId?: string | undefined;
  archivedAt?: Date | null;
}

export interface LinearSdkIssueLabelLike {
  id: string;
  name: string;
  teamId?: string | undefined;
  archivedAt?: Date | string | null;
}

export interface LinearSdkIssueRelationLike {
  id: string;
  type: string;
  issue?: Awaitable<unknown> | undefined;
  issueId?: string | undefined;
  relatedIssue?: Awaitable<unknown> | undefined;
  relatedIssueId?: string | undefined;
}

export interface LinearSdkIssueNodeLike {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  url?: string | null;
  createdAt?: Date | string | null;
  updatedAt: Date | string;
  teamId?: string | undefined;
  projectId?: string | undefined;
  state?: Awaitable<unknown> | undefined;
  parent?: Awaitable<unknown> | undefined;
  labels?(
    variables?: LinearConnectionVariables,
  ): Awaitable<LinearConnectionLike<LinearSdkIssueLabelLike>>;
  relations?(
    variables?: LinearConnectionVariables,
  ): Awaitable<LinearConnectionLike<LinearSdkIssueRelationLike>>;
  inverseRelations?(
    variables?: LinearConnectionVariables,
  ): Awaitable<LinearConnectionLike<LinearSdkIssueRelationLike>>;
}

export interface LinearSdkIssueLike extends LinearSdkIssueNodeLike {}

export type LinearConnectionVariables = {
  first?: number;
  after?: string;
  includeArchived?: boolean;
};

export interface LinearSdkTeamLike {
  id: string;
  key: string;
  name: string;
  displayName: string;
  projects(variables?: { first?: number }): Awaitable<
    LinearConnectionLike<LinearSdkProjectLike>
  >;
  states(variables?: { first?: number }): Awaitable<
    LinearConnectionLike<LinearSdkWorkflowStateLike>
  >;
}

export interface LinearSdkClientLike {
  viewer: Awaitable<LinearSdkViewerLike>;
  teams(variables?: { first?: number }): Awaitable<
    LinearConnectionLike<LinearSdkTeamLike>
  >;
  issue?(id: string): Awaitable<LinearSdkIssueLike | undefined>;
  issues?(variables?: {
    first?: number;
    after?: string;
    orderBy?: string;
    filter?: unknown;
  }): Awaitable<LinearConnectionLike<LinearSdkIssueLike>>;
  updateIssue?(
    id: string,
    input: {
      stateId?: string;
      labelIds?: string[];
      description?: string | null;
    },
  ): Awaitable<{ success?: boolean | null }>;
  createComment?(input: {
    issueId?: string;
    body?: string;
  }): Awaitable<{ success?: boolean | null }>;
  issueLabels?(variables?: {
    first?: number;
    after?: string;
    includeArchived?: boolean;
    filter?: unknown;
  }): Awaitable<LinearConnectionLike<LinearSdkIssueLabelLike>>;
  createIssueLabel?(input: {
    name: string;
    teamId?: string | null;
    color?: string;
  }): Awaitable<{
    success?: boolean | null;
    issueLabel?: Awaitable<unknown> | undefined;
  }>;
}

export type LinearViewerRecord = {
  id: string;
  name: string;
  displayName: string | null;
  email: string | null;
};

export type LinearProjectRecord = {
  id: string;
  name: string;
  url: string | null;
};

export type LinearWorkflowStateRecord = {
  id: string;
  name: string;
  type: string;
  teamId: string | null;
  archived: boolean;
};

export type LinearIssueReferenceRecord = {
  id: string;
  identifier: string | null;
  status: LinearWorkflowStateRecord | null;
  url: string | null;
};

export type LinearIssueRelationRecord = {
  id: string;
  type: string;
  issue: LinearIssueReferenceRecord;
  relatedIssue: LinearIssueReferenceRecord;
};

export type LinearIssueLabelRecord = {
  id: string;
  name: string;
  teamId: string | null;
  archived: boolean;
};

export type LinearHydratedIssueRecord = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  url: string | null;
  createdAt: string | null;
  updatedAt: string;
  state: LinearWorkflowStateRecord;
  labels: LinearIssueLabelRecord[];
  parent: LinearIssueReferenceRecord | null;
  relations: LinearIssueRelationRecord[];
  inverseRelations: LinearIssueRelationRecord[];
};

export interface LinearTeamHandle {
  id: string;
  key: string;
  name: string;
  displayName: string;
  listProjects(): Promise<LinearProjectRecord[]>;
  listWorkflowStates(): Promise<LinearWorkflowStateRecord[]>;
}

export type LinearPlanningClientOptions = {
  apiKey?: string;
  sdkClient?: LinearSdkClientLike;
};

const LINEAR_PAGE_SIZE = 250;

export class LinearPlanningClient {
  private readonly sdkClient: LinearSdkClientLike;

  constructor(options: LinearPlanningClientOptions) {
    this.sdkClient = (
      options.sdkClient ??
      new LinearSdkClient({
        apiKey: options.apiKey,
      })
    ) as LinearSdkClientLike;
  }

  async getViewer(): Promise<LinearViewerRecord> {
    try {
      const viewer = await this.sdkClient.viewer;

      return {
        id: viewer.id,
        name: viewer.name,
        displayName: viewer.displayName ?? null,
        email: viewer.email ?? null,
      };
    } catch (error) {
      throw LinearProviderFailure.from(
        error,
        "Failed to authenticate with Linear.",
      );
    }
  }

  async listTeams(): Promise<LinearTeamHandle[]> {
    try {
      const response = await this.sdkClient.teams({ first: LINEAR_PAGE_SIZE });
      return response.nodes.map((team) => new SdkLinearTeamHandle(team));
    } catch (error) {
      throw LinearProviderFailure.from(error, "Failed to load Linear teams.");
    }
  }

  async listIssueIds(input: {
    teamId: string;
    projectId?: string | null;
    stateIds: string[];
  }): Promise<string[]> {
    const issues = this.sdkClient.issues;

    if (issues === undefined) {
      throw new Error("Linear SDK client does not support issue listing.");
    }

    const ids: string[] = [];
    let after: string | undefined;

    try {
      do {
        const response = await issues({
          first: LINEAR_PAGE_SIZE,
          after,
          orderBy: "updatedAt",
          filter: buildIssueListFilter(input),
        });

        for (const issue of response.nodes) {
          ids.push(issue.id);
        }

        after = response.pageInfo?.hasNextPage
          ? response.pageInfo.endCursor ?? undefined
          : undefined;
      } while (after !== undefined);

      return ids;
    } catch (error) {
      throw LinearProviderFailure.from(
        error,
        "Failed to load Linear issues.",
      );
    }
  }

  async getHydratedIssue(id: string): Promise<LinearHydratedIssueRecord | null> {
    const issueQuery = this.sdkClient.issue;

    if (issueQuery === undefined) {
      throw new Error("Linear SDK client does not support issue reads.");
    }

    try {
      const issue = await issueQuery(id);

      if (issue === undefined) {
        return null;
      }

      return this.hydrateIssue(issue);
    } catch (error) {
      if (isNotFoundError(error, id)) {
        return null;
      }

      throw LinearProviderFailure.from(
        error,
        `Failed to load Linear issue '${id}'.`,
      );
    }
  }

  async updateIssue(
    id: string,
    input: {
      stateId?: string;
      labelIds?: string[];
      description?: string | null;
    },
  ): Promise<void> {
    const updateIssue = this.sdkClient.updateIssue;

    if (updateIssue === undefined) {
      throw new Error("Linear SDK client does not support issue writes.");
    }

    try {
      const payload = await updateIssue(id, input);

      if (payload.success === false) {
        throw new Error(`Linear rejected update for issue '${id}'.`);
      }
    } catch (error) {
      throw LinearProviderFailure.from(
        error,
        `Failed to update Linear issue '${id}'.`,
      );
    }
  }

  async createComment(input: { issueId: string; body: string }): Promise<void> {
    const createComment = this.sdkClient.createComment;

    if (createComment === undefined) {
      throw new Error("Linear SDK client does not support comment writes.");
    }

    try {
      const payload = await createComment(input);

      if (payload.success === false) {
        throw new Error(
          `Linear rejected comment creation for issue '${input.issueId}'.`,
        );
      }
    } catch (error) {
      throw LinearProviderFailure.from(
        error,
        `Failed to create a Linear comment for issue '${input.issueId}'.`,
      );
    }
  }

  async listIssueLabels(input: {
    teamId?: string | null;
  } = {}): Promise<LinearIssueLabelRecord[]> {
    const issueLabels = this.sdkClient.issueLabels;

    if (issueLabels === undefined) {
      throw new Error("Linear SDK client does not support issue-label reads.");
    }

    const records: LinearIssueLabelRecord[] = [];
    let after: string | undefined;

    try {
      do {
        const response = await issueLabels({
          first: LINEAR_PAGE_SIZE,
          after,
          includeArchived: false,
          filter:
            input.teamId === undefined
              ? undefined
              : {
                  team: {
                    id:
                      input.teamId === null
                        ? { null: true }
                        : { eq: input.teamId },
                  },
                },
        });

        records.push(...response.nodes.map(toIssueLabelRecord));
        after = response.pageInfo?.hasNextPage
          ? response.pageInfo.endCursor ?? undefined
          : undefined;
      } while (after !== undefined);

      return records;
    } catch (error) {
      throw LinearProviderFailure.from(
        error,
        "Failed to load Linear issue labels.",
      );
    }
  }

  async createIssueLabel(input: {
    name: string;
    teamId?: string | null;
    color?: string;
  }): Promise<LinearIssueLabelRecord> {
    const createIssueLabel = this.sdkClient.createIssueLabel;

    if (createIssueLabel === undefined) {
      throw new Error("Linear SDK client does not support issue-label writes.");
    }

    try {
      const payload = await createIssueLabel({
        name: input.name,
        teamId: input.teamId ?? undefined,
        color: input.color,
      });

      if (payload.success === false) {
        throw new Error(`Linear rejected label creation for '${input.name}'.`);
      }

      const issueLabel = await resolveLinkedResource<LinearSdkIssueLabelLike>(
        payload.issueLabel,
      );

      if (issueLabel === undefined) {
        throw new Error(`Linear did not return the created label '${input.name}'.`);
      }

      return toIssueLabelRecord(issueLabel);
    } catch (error) {
      throw LinearProviderFailure.from(
        error,
        `Failed to create Linear label '${input.name}'.`,
      );
    }
  }

  private async hydrateIssue(
    issue: LinearSdkIssueNodeLike,
  ): Promise<LinearHydratedIssueRecord> {
    const [state, parent, labels, relations, inverseRelations] =
      await Promise.all([
        resolveLinkedResource<LinearSdkWorkflowStateLike>(issue.state),
        resolveLinkedResource<LinearSdkIssueNodeLike>(issue.parent),
        collectConnectionNodes<LinearSdkIssueLabelLike>(
          issue.labels ? (variables) => issue.labels!(variables) : undefined,
        ),
        collectConnectionNodes<LinearSdkIssueRelationLike>(
          issue.relations ? (variables) => issue.relations!(variables) : undefined,
        ),
        collectConnectionNodes<LinearSdkIssueRelationLike>(
          issue.inverseRelations
            ? (variables) => issue.inverseRelations!(variables)
            : undefined,
        ),
      ]);

    const resolvedState = toWorkflowStateRecord(state);

    if (resolvedState === null) {
      throw new Error(
        `Linear issue '${issue.id}' is missing a workflow state.`,
      );
    }

    const currentReference: LinearIssueReferenceRecord = {
      id: issue.id,
      identifier: issue.identifier,
      status: resolvedState,
      url: toNullableString(issue.url),
    };

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: toNullableString(issue.description),
      priority: normalizePriority(issue.priority),
      url: toNullableString(issue.url),
      createdAt: toIsoString(issue.createdAt),
      updatedAt: requireIsoString(issue.updatedAt, `Linear issue '${issue.id}'`),
      state: resolvedState,
      labels: labels.map(toIssueLabelRecord),
      parent: await this.toIssueReference(parent, null),
      relations: await Promise.all(
        relations.map((relation) =>
          this.toRelationRecord(relation, currentReference),
        ),
      ),
      inverseRelations: await Promise.all(
        inverseRelations.map((relation) =>
          this.toRelationRecord(relation, currentReference),
        ),
      ),
    };
  }

  private async toRelationRecord(
    relation: LinearSdkIssueRelationLike,
    currentReference: LinearIssueReferenceRecord,
  ): Promise<LinearIssueRelationRecord> {
    const [issue, relatedIssue] = await Promise.all([
      relation.issueId === currentReference.id
        ? currentReference
        : this.toIssueReference(
            await resolveLinkedResource<LinearSdkIssueNodeLike>(relation.issue),
            relation.issueId ?? null,
          ),
      relation.relatedIssueId === currentReference.id
        ? currentReference
        : this.toIssueReference(
            await resolveLinkedResource<LinearSdkIssueNodeLike>(relation.relatedIssue),
            relation.relatedIssueId ?? null,
          ),
    ]);

    return {
      id: relation.id,
      type: relation.type,
      issue,
      relatedIssue,
    };
  }

  private async toIssueReference(
    issue: LinearSdkIssueNodeLike | undefined,
    fallbackId: string | null,
  ): Promise<LinearIssueReferenceRecord> {
    if (issue === undefined) {
      return {
        id: fallbackId ?? "",
        identifier: fallbackId,
        status: null,
        url: null,
      };
    }

    const state = await resolveLinkedResource<LinearSdkWorkflowStateLike>(
      issue.state,
    );

    return {
      id: issue.id,
      identifier: issue.identifier ?? issue.id,
      status: toWorkflowStateRecord(state),
      url: toNullableString(issue.url),
    };
  }
}

class SdkLinearTeamHandle implements LinearTeamHandle {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly displayName: string;

  constructor(private readonly team: LinearSdkTeamLike) {
    this.id = team.id;
    this.key = team.key;
    this.name = team.name;
    this.displayName = team.displayName;
  }

  async listProjects(): Promise<LinearProjectRecord[]> {
    try {
      const response = await this.team.projects({ first: LINEAR_PAGE_SIZE });

      return response.nodes.map((project) => ({
        id: project.id,
        name: project.name,
        url: project.url ?? null,
      }));
    } catch (error) {
      throw LinearProviderFailure.from(
        error,
        `Failed to load projects for Linear team '${this.name}'.`,
      );
    }
  }

  async listWorkflowStates(): Promise<LinearWorkflowStateRecord[]> {
    try {
      const response = await this.team.states({ first: LINEAR_PAGE_SIZE });

      return response.nodes.map((state) => ({
        id: state.id,
        name: state.name,
        type: state.type,
        teamId: state.teamId ?? null,
        archived: state.archivedAt != null,
      }));
    } catch (error) {
      throw LinearProviderFailure.from(
        error,
        `Failed to load workflow states for Linear team '${this.name}'.`,
      );
    }
  }
}

function buildIssueListFilter(input: {
  teamId: string;
  projectId?: string | null;
  stateIds: string[];
}): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    team: {
      id: {
        eq: input.teamId,
      },
    },
    state: {
      id: {
        in: input.stateIds,
      },
    },
  };

  if (input.projectId) {
    filter.project = {
      id: {
        eq: input.projectId,
      },
    };
  }

  return filter;
}
async function collectConnectionNodes<TNode>(
  fetchPage:
    | ((variables: LinearConnectionVariables) => Awaitable<LinearConnectionLike<TNode>>)
    | undefined,
): Promise<TNode[]> {
  if (fetchPage === undefined) {
    return [];
  }

  const nodes: TNode[] = [];
  let after: string | undefined;

  do {
    const response = await fetchPage({
      first: LINEAR_PAGE_SIZE,
      after,
      includeArchived: false,
    });

    nodes.push(...response.nodes);
    after = response.pageInfo?.hasNextPage
      ? response.pageInfo.endCursor ?? undefined
      : undefined;
  } while (after !== undefined);

  return nodes;
}

async function resolveLinkedResource<T>(
  value: Awaitable<unknown> | unknown | undefined,
): Promise<T | undefined> {
  return value === undefined ? undefined : ((await value) as T | undefined);
}

function toWorkflowStateRecord(
  state: LinearSdkWorkflowStateLike | undefined,
): LinearWorkflowStateRecord | null {
  if (state === undefined) {
    return null;
  }

  return {
    id: state.id,
    name: state.name,
    type: state.type,
    teamId: state.teamId ?? null,
    archived: state.archivedAt != null,
  };
}

function toIssueLabelRecord(label: LinearSdkIssueLabelLike): LinearIssueLabelRecord {
  return {
    id: label.id,
    name: label.name,
    teamId: label.teamId ?? null,
    archived:
      label.archivedAt instanceof Date
        ? true
        : typeof label.archivedAt === "string" && label.archivedAt.trim() !== "",
  };
}

function normalizePriority(priority: number | null | undefined): number | null {
  if (priority === undefined || priority === null || priority <= 0) {
    return null;
  }

  return priority;
}

function requireIsoString(
  value: Date | string | null | undefined,
  label: string,
): string {
  const iso = toIsoString(value);

  if (iso === null) {
    throw new Error(`${label} is missing an updated timestamp.`);
  }

  return iso;
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function isNotFoundError(error: unknown, id: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("not found") && message.includes(id.toLowerCase());
}
