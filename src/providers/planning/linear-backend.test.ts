import assert from "node:assert/strict";
import test from "node:test";

import { AuthenticationLinearError } from "@linear/sdk";

import type { PlanningLinearProviderConfig } from "../../config/types.js";

import {
  LinearPlanningClient,
  type LinearSdkClientLike,
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

type RequiredStateName =
  | "backlog"
  | "design"
  | "plan"
  | "implement"
  | "review"
  | "blocked"
  | "done"
  | "canceled";
