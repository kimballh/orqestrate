import type {
  LinearStatusMappingKey,
  PlanningLinearProviderConfig,
} from "../../../config/types.js";
import type { ProviderErrorCode } from "../../../domain-model.js";

import type {
  LinearPlanningClient,
  LinearProjectRecord,
  LinearTeamHandle,
  LinearViewerRecord,
  LinearWorkflowStateRecord,
} from "./client.js";
import { createLinearFailure } from "./errors.js";

export const LINEAR_CANONICAL_STATUSES = [
  "backlog",
  "design",
  "plan",
  "implement",
  "review",
  "blocked",
  "done",
  "canceled",
] as const;

export type LinearCanonicalStatus = (typeof LINEAR_CANONICAL_STATUSES)[number];

export type LinearWorkflowStateNameMap = Record<
  LinearCanonicalStatus,
  string
>;

export type ResolvedLinearWorkflowStates = Record<
  LinearCanonicalStatus,
  LinearWorkflowStateRecord
>;

export type LinearTeamSummary = {
  id: string;
  key: string;
  name: string;
  displayName: string;
};

export type LinearPlanningConfigAdapter = {
  client: LinearPlanningClient;
  provider: {
    name: string;
    kind: "planning.linear";
    teamSelector: string;
    projectSelector?: string;
    mapping: PlanningLinearProviderConfig["mapping"];
    workflowStateNames: LinearWorkflowStateNameMap;
  };
  viewer: LinearViewerRecord;
  team: LinearTeamSummary;
  project: LinearProjectRecord | null;
  workflowStates: ResolvedLinearWorkflowStates;
};

const DEFAULT_LINEAR_WORKFLOW_STATE_NAMES: LinearWorkflowStateNameMap = {
  backlog: "Backlog",
  design: "Design",
  plan: "Plan",
  implement: "Implement",
  review: "Review",
  blocked: "Blocked",
  done: "Done",
  canceled: "Canceled",
};

const LINEAR_MAPPING_KEY_TO_STATUS = {
  backlog_status: "backlog",
  design_status: "design",
  plan_status: "plan",
  implement_status: "implement",
  review_status: "review",
  blocked_status: "blocked",
  done_status: "done",
  canceled_status: "canceled",
} as const satisfies Record<LinearStatusMappingKey, LinearCanonicalStatus>;

const ALLOWED_LINEAR_MAPPING_KEYS = new Set(
  Object.keys(LINEAR_MAPPING_KEY_TO_STATUS),
);

export function validateLinearPlanningProviderConfig(
  config: PlanningLinearProviderConfig,
): void {
  if (config.tokenEnv.trim() === "") {
    throw createValidationFailure(
      "Linear provider config must include a token_env reference.",
      { field: "token_env" },
    );
  }

  if (config.team.trim() === "") {
    throw createValidationFailure(
      "Linear provider config must include a non-empty team selector.",
      { field: "team" },
    );
  }

  if (config.project !== undefined && config.project.trim() === "") {
    throw createValidationFailure(
      "Linear provider config project selector must be non-empty when provided.",
      { field: "project" },
    );
  }

  const invalidMappingKeys = Object.keys(config.mapping).filter(
    (key) => !ALLOWED_LINEAR_MAPPING_KEYS.has(key),
  );

  if (invalidMappingKeys.length > 0) {
    throw createValidationFailure(
      `Unsupported planning.linear mapping key '${invalidMappingKeys[0]}'.`,
      { field: `mapping.${invalidMappingKeys[0]}` },
    );
  }

  const resolvedStateNames = resolveLinearWorkflowStateNames(config.mapping);
  const duplicatedNames = findDuplicateNames(Object.values(resolvedStateNames));

  if (duplicatedNames.length > 0) {
    throw createValidationFailure(
      `planning.linear mapping resolves multiple canonical states to '${duplicatedNames[0]}'.`,
      { field: "mapping" },
    );
  }
}

export function resolveLinearWorkflowStateNames(
  mapping: PlanningLinearProviderConfig["mapping"],
): LinearWorkflowStateNameMap {
  const resolved = { ...DEFAULT_LINEAR_WORKFLOW_STATE_NAMES };

  for (const [mappingKey, value] of Object.entries(mapping)) {
    const canonicalStatus =
      LINEAR_MAPPING_KEY_TO_STATUS[mappingKey as LinearStatusMappingKey];

    if (canonicalStatus !== undefined) {
      resolved[canonicalStatus] = value;
    }
  }

  return resolved;
}

export async function resolveLinearPlanningConfigAdapter(input: {
  client: LinearPlanningClient;
  config: PlanningLinearProviderConfig;
}): Promise<LinearPlanningConfigAdapter> {
  validateLinearPlanningProviderConfig(input.config);

  const workflowStateNames = resolveLinearWorkflowStateNames(input.config.mapping);
  const viewer = await input.client.getViewer();
  const teams = await input.client.listTeams();
  const team = selectTeam(teams, input.config.team);
  const project =
    input.config.project === undefined
      ? null
      : selectProject(await team.listProjects(), input.config.project, team);
  const workflowStates = selectWorkflowStates(
    await team.listWorkflowStates(),
    workflowStateNames,
    team,
  );

  return {
    client: input.client,
    provider: {
      name: input.config.name,
      kind: input.config.kind,
      teamSelector: input.config.team,
      projectSelector: input.config.project,
      mapping: input.config.mapping,
      workflowStateNames,
    },
    viewer,
    team: toTeamSummary(team),
    project,
    workflowStates,
  };
}

function selectTeam(
  teams: LinearTeamHandle[],
  selector: string,
): LinearTeamHandle {
  return selectSingleMatch(
    teams,
    selector,
    "team",
    (team) => [team.id, team.key, team.name, team.displayName],
  );
}

function selectProject(
  projects: LinearProjectRecord[],
  selector: string,
  team: LinearTeamHandle,
): LinearProjectRecord {
  return selectSingleMatch(projects, selector, "project", (project) => [
    project.id,
    project.name,
    project.url ?? "",
  ]);
}

function selectWorkflowStates(
  states: LinearWorkflowStateRecord[],
  names: LinearWorkflowStateNameMap,
  team: LinearTeamHandle,
): ResolvedLinearWorkflowStates {
  const activeStates = states.filter((state) => !state.archived);
  const resolved = {} as Partial<ResolvedLinearWorkflowStates>;
  const missing: string[] = [];

  for (const [canonicalStatus, expectedName] of Object.entries(names) as Array<
    [LinearCanonicalStatus, string]
  >) {
    const matches = activeStates.filter((state) =>
      stringsEqual(state.name, expectedName),
    );

    if (matches.length === 0) {
      missing.push(expectedName);
      continue;
    }

    if (matches.length > 1) {
      throw createValidationFailure(
        `Linear team '${team.name}' has multiple workflow states named '${expectedName}'.`,
        { field: canonicalStatus },
      );
    }

    resolved[canonicalStatus] = matches[0];
  }

  if (missing.length > 0) {
    throw createFailure(
      "validation",
      `Linear team '${team.name}' is missing required workflow states: ${missing.join(", ")}.`,
      { field: "workflowStates" },
    );
  }

  return resolved as ResolvedLinearWorkflowStates;
}

function selectSingleMatch<TItem>(
  items: TItem[],
  selector: string,
  label: "team" | "project",
  extractCandidates: (item: TItem) => string[],
): TItem {
  const exactMatches = items.filter((item) =>
    extractCandidates(item).some((candidate) => candidate === selector),
  );

  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  if (exactMatches.length > 1) {
    throw createValidationFailure(
      `Linear ${label} selector '${selector}' matched multiple records.`,
      { field: label },
    );
  }

  const normalizedSelector = selector.trim().toLowerCase();
  const fuzzyMatches = items.filter((item) =>
    extractCandidates(item).some(
      (candidate) => candidate.trim().toLowerCase() === normalizedSelector,
    ),
  );

  if (fuzzyMatches.length === 1) {
    return fuzzyMatches[0];
  }

  if (fuzzyMatches.length > 1) {
    throw createValidationFailure(
      `Linear ${label} selector '${selector}' matched multiple records.`,
      { field: label },
    );
  }

  throw createFailure(
    "not_found",
    `Linear ${label} '${selector}' was not found.`,
    { field: label },
  );
}

function toTeamSummary(team: LinearTeamHandle): LinearTeamSummary {
  return {
    id: team.id,
    key: team.key,
    name: team.name,
    displayName: team.displayName,
  };
}

function stringsEqual(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function findDuplicateNames(names: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const name of names) {
    const normalized = name.trim().toLowerCase();

    if (seen.has(normalized)) {
      duplicates.add(name);
      continue;
    }

    seen.add(normalized);
  }

  return [...duplicates];
}

function createValidationFailure(
  message: string,
  details: { field: string },
) {
  return createFailure("validation", message, details);
}

function createFailure(
  code: ProviderErrorCode,
  message: string,
  details: { field: string },
) {
  return createLinearFailure(code, message, {
    retryable: false,
    details,
  });
}
