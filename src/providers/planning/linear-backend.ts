import type { PlanningLinearProviderConfig } from "../../config/types.js";
import type { WorkItemRecord, WorkItemStatus, WorkPhase } from "../../domain-model.js";
import type { ListActionableWorkItemsInput } from "../../core/planning-backend.js";

import {
  resolveLinearPlanningConfigAdapter,
  validateLinearPlanningProviderConfig,
  type LinearPlanningConfigAdapter,
} from "./linear/config-adapter.js";
import { LinearPlanningClient } from "./linear/client.js";
import { formatLinearProviderFailure } from "./linear/errors.js";
import {
  compareWorkItems,
  mapLinearIssueToWorkItem,
} from "./linear/work-item-mapper.js";
import { UnimplementedPlanningBackend } from "./unimplemented-planning-backend.js";

type LinearPlanningBackendOptions = {
  client?: LinearPlanningClient;
  apiKey?: string;
};

const ACTIONABLE_STATUSES = [
  "design",
  "plan",
  "implement",
  "review",
] as const satisfies readonly WorkItemStatus[];

const ACTIONABLE_STATUS_SET = new Set<WorkItemStatus>(ACTIONABLE_STATUSES);

export class LinearPlanningBackend extends UnimplementedPlanningBackend<PlanningLinearProviderConfig> {
  private client: LinearPlanningClient | null;
  private readonly apiKey?: string;
  private configAdapter: LinearPlanningConfigAdapter | null = null;
  private configAdapterPromise: Promise<LinearPlanningConfigAdapter> | null = null;

  constructor(
    config: PlanningLinearProviderConfig,
    options: LinearPlanningBackendOptions = {},
  ) {
    super(config);
    this.client = options.client ?? null;
    this.apiKey = options.apiKey;
  }

  async validateConfig(): Promise<void> {
    validateLinearPlanningProviderConfig(this.config);
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    try {
      const adapter = await this.getConfigAdapter();
      const scope =
        adapter.project === null
          ? `team '${adapter.team.name}'`
          : `team '${adapter.team.name}' and project '${adapter.project.name}'`;

      return {
        ok: true,
        message: `Connected to Linear ${scope}.`,
      };
    } catch (error) {
      return {
        ok: false,
        message: formatLinearProviderFailure(error),
      };
    }
  }

  async getConfigAdapter(): Promise<LinearPlanningConfigAdapter> {
    if (this.configAdapter !== null) {
      return this.configAdapter;
    }

    if (this.configAdapterPromise === null) {
      this.configAdapterPromise = resolveLinearPlanningConfigAdapter({
        client: this.getClient(),
        config: this.config,
      })
        .then((adapter) => {
          this.configAdapter = adapter;
          return adapter;
        })
        .finally(() => {
          this.configAdapterPromise = null;
        });
    }

    return this.configAdapterPromise;
  }

  async listActionableWorkItems(
    input: ListActionableWorkItemsInput,
  ): Promise<WorkItemRecord[]> {
    assertNonNegativeInteger(input.limit, "limit");

    if (input.limit === 0) {
      return [];
    }

    const adapter = await this.getConfigAdapter();
    const actionableReadBlocker = adapter.client.getActionableReadBlocker();

    if (actionableReadBlocker !== null) {
      throw new Error(actionableReadBlocker);
    }

    const candidateIds = await adapter.client.listIssueIds({
      teamId: adapter.team.id,
      projectId: adapter.project?.id ?? null,
      stateIds: ACTIONABLE_STATUSES.map((status) => adapter.workflowStates[status].id),
    });
    const issues = await Promise.all(
      candidateIds.map((id) => adapter.client.getHydratedIssue(id)),
    );
    const records = issues
      .filter((issue): issue is NonNullable<(typeof issues)[number]> => issue !== null)
      .map((issue) => mapLinearIssueToWorkItem(issue, adapter));

    return records
      .filter((record) => isActionableRecord(record, input))
      .sort(compareWorkItems)
      .slice(0, input.limit);
  }

  async getWorkItem(id: string): Promise<WorkItemRecord | null> {
    assertNonEmptyString(id, "id");

    const adapter = await this.getConfigAdapter();
    const issue = await adapter.client.getHydratedIssue(id);

    return issue === null ? null : mapLinearIssueToWorkItem(issue, adapter);
  }

  async buildDeepLink(id: string): Promise<string | null> {
    const workItem = await this.getWorkItem(id);
    return workItem?.url ?? null;
  }

  private getClient(): LinearPlanningClient {
    if (this.client === null) {
      this.client = new LinearPlanningClient({
        apiKey: this.apiKey,
      });
    }

    return this.client;
  }
}

function isActionableRecord(
  record: WorkItemRecord,
  input: ListActionableWorkItemsInput,
): boolean {
  if (!ACTIONABLE_STATUS_SET.has(record.status)) {
    return false;
  }

  const statusFilter = new Set<WorkItemStatus>(
    (input.statuses ?? ACTIONABLE_STATUSES).filter((status) =>
      ACTIONABLE_STATUS_SET.has(status),
    ),
  );

  if (!statusFilter.has(record.status)) {
    return false;
  }

  if (record.phase === "none") {
    return false;
  }

  if (input.phases && !input.phases.includes(record.phase as WorkPhase)) {
    return false;
  }

  if (hasActiveLease(record.orchestration.leaseUntil)) {
    return false;
  }

  return record.blockedByIds.length === 0;
}

function hasActiveLease(leaseUntil: string | null | undefined): boolean {
  if (leaseUntil === undefined || leaseUntil === null || leaseUntil.trim() === "") {
    return false;
  }

  const timestamp = Date.parse(leaseUntil);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

function assertNonEmptyString(value: string, label: string): void {
  if (value.trim() === "") {
    throw new Error(`${label} must be non-empty.`);
  }
}
