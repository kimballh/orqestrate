import { LinearClient as LinearSdkClient } from "@linear/sdk";

import { LinearProviderFailure } from "./errors.js";

type Awaitable<T> = Promise<T> | PromiseLike<T>;

export type LinearConnectionLike<TNode> = {
  nodes: TNode[];
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
    this.sdkClient =
      options.sdkClient ??
      new LinearSdkClient({
        apiKey: options.apiKey,
      });
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
