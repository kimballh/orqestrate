import type { PlanningLinearProviderConfig } from "../../config/types.js";
import type {
  OrchestrationState,
  ReviewOutcome,
  WorkItemRecord,
  WorkItemStatus,
  WorkPhase,
  WorkPhaseOrNone,
} from "../../domain-model.js";
import type {
  AppendCommentInput,
  ClaimWorkItemInput,
  ListActionableWorkItemsInput,
  MarkWorkItemRunningInput,
  RenewLeaseInput,
  TransitionWorkItemInput,
} from "../../core/planning-backend.js";

import {
  resolveLinearPlanningConfigAdapter,
  validateLinearPlanningProviderConfig,
  type LinearPlanningConfigAdapter,
} from "./linear/config-adapter.js";
import {
  LinearPlanningClient,
  type LinearHydratedIssueRecord,
  type LinearIssueLabelRecord,
} from "./linear/client.js";
import { formatLinearProviderFailure } from "./linear/errors.js";
import {
  buildClaimPatch,
  buildLeaseRenewalPatch,
  buildRunningPatch,
  buildTransitionPatch,
} from "./linear/mutation-builder.js";
import {
  buildLinearMachineStateLabelNames,
  isLinearProviderOwnedLabel,
  normalizeLinearLabelName,
} from "./linear/machine-state/label-binding.js";
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
  private providerLabelCatalog: Map<string, LinearIssueLabelRecord> | null = null;
  private providerLabelCatalogPromise: Promise<Map<string, LinearIssueLabelRecord>> | null =
    null;

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

  async claimWorkItem(input: ClaimWorkItemInput): Promise<WorkItemRecord> {
    assertNonEmptyString(input.id, "id");
    assertNonEmptyString(input.owner, "owner");
    assertNonEmptyString(input.runId, "runId");
    assertValidFutureTimestamp(input.leaseUntil, "leaseUntil");

    const context = await this.loadIssueContext(input.id);

    if (!ACTIONABLE_STATUS_SET.has(context.record.status)) {
      throw new Error(
        `Issue '${context.record.id}' is in '${context.record.status}' and cannot be claimed.`,
      );
    }

    if (context.record.phase !== input.phase) {
      throw new Error(
        `Issue '${context.record.id}' is in phase '${context.record.phase}', not '${input.phase}'.`,
      );
    }

    if (hasActiveLease(context.record.orchestration.leaseUntil)) {
      throw new Error(`Issue '${context.record.id}' already has an active lease.`);
    }

    if (context.record.blockedByIds.length > 0) {
      throw new Error(`Issue '${context.record.id}' still has open blockers.`);
    }

    const labelCatalog = await this.ensureProviderLabels(
      buildLinearMachineStateLabelNames({
        phase: input.phase,
        state: "claimed",
        reviewOutcome: context.record.orchestration.reviewOutcome ?? "none",
      }),
    );

    await context.adapter.client.updateIssue(
      context.issue.id,
      buildClaimPatch({
        issue: context.issue,
        record: context.record,
        phase: input.phase,
        owner: input.owner,
        runId: input.runId,
        leaseUntil: input.leaseUntil,
        labelCatalog,
      }),
    );

    return this.requireWorkItem(input.id, context.adapter);
  }

  async markWorkItemRunning(
    input: MarkWorkItemRunningInput,
  ): Promise<WorkItemRecord> {
    assertNonEmptyString(input.id, "id");
    assertNonEmptyString(input.owner, "owner");
    assertNonEmptyString(input.runId, "runId");
    assertValidFutureTimestamp(input.leaseUntil, "leaseUntil");

    const context = await this.loadIssueContext(input.id);
    assertLeaseHolder(context.record, input.owner, input.runId);

    if (
      context.record.orchestration.state !== "claimed" &&
      context.record.orchestration.state !== "running"
    ) {
      throw new Error(
        `Issue '${context.record.id}' cannot enter running from '${context.record.orchestration.state}'.`,
      );
    }

    const labelCatalog = await this.ensureProviderLabels(
      buildLinearMachineStateLabelNames({
        phase: context.record.phase,
        state: "running",
        reviewOutcome: context.record.orchestration.reviewOutcome ?? "none",
      }),
    );

    await context.adapter.client.updateIssue(
      context.issue.id,
      buildRunningPatch({
        issue: context.issue,
        record: context.record,
        owner: input.owner,
        runId: input.runId,
        leaseUntil: input.leaseUntil,
        labelCatalog,
      }),
    );

    return this.requireWorkItem(input.id, context.adapter);
  }

  async renewLease(input: RenewLeaseInput): Promise<WorkItemRecord> {
    assertNonEmptyString(input.id, "id");
    assertNonEmptyString(input.owner, "owner");
    assertNonEmptyString(input.runId, "runId");
    assertValidFutureTimestamp(input.leaseUntil, "leaseUntil");

    const context = await this.loadIssueContext(input.id);
    assertLeaseHolder(context.record, input.owner, input.runId);

    if (
      context.record.orchestration.state !== "claimed" &&
      context.record.orchestration.state !== "running"
    ) {
      throw new Error(
        `Issue '${context.record.id}' cannot renew a lease while in '${context.record.orchestration.state}'.`,
      );
    }

    const labelCatalog = await this.ensureProviderLabels(
      buildLinearMachineStateLabelNames({
        phase: context.record.phase,
        state: context.record.orchestration.state,
        reviewOutcome: context.record.orchestration.reviewOutcome ?? "none",
      }),
    );

    await context.adapter.client.updateIssue(
      context.issue.id,
      buildLeaseRenewalPatch({
        issue: context.issue,
        record: context.record,
        owner: input.owner,
        runId: input.runId,
        leaseUntil: input.leaseUntil,
        labelCatalog,
      }),
    );

    return this.requireWorkItem(input.id, context.adapter);
  }

  async transitionWorkItem(
    input: TransitionWorkItemInput,
  ): Promise<WorkItemRecord> {
    assertNonEmptyString(input.id, "id");

    const context = await this.loadIssueContext(input.id);

    if (
      hasActiveLease(context.record.orchestration.leaseUntil) &&
      context.record.orchestration.runId !== null &&
      input.runId !== undefined &&
      input.runId !== null &&
      input.runId !== context.record.orchestration.runId
    ) {
      throw new Error(
        `Issue '${context.record.id}' is leased by run '${context.record.orchestration.runId}', not '${input.runId}'.`,
      );
    }

    const resolvedPhase = resolveTransitionPhase(
      input.nextStatus,
      input.nextPhase,
      context.record.phase,
    );
    const reviewOutcome = input.reviewOutcome ?? "none";
    const labelCatalog = await this.ensureProviderLabels(
      buildLinearMachineStateLabelNames({
        phase: resolvedPhase,
        state: input.state,
        reviewOutcome,
      }),
    );

    await context.adapter.client.updateIssue(
      context.issue.id,
      buildTransitionPatch({
        issue: context.issue,
        record: context.record,
        nextStatus: input.nextStatus,
        nextPhase: input.nextPhase,
        state: input.state,
        reviewOutcome: input.reviewOutcome,
        blockedReason: input.blockedReason,
        lastError: input.lastError,
        runId: input.runId,
        workflowStates: context.adapter.workflowStates,
        labelCatalog,
      }),
    );

    return this.requireWorkItem(input.id, context.adapter);
  }

  async appendComment(input: AppendCommentInput): Promise<void> {
    assertNonEmptyString(input.id, "id");
    assertNonEmptyString(input.body, "body");

    const context = await this.loadIssueContext(input.id);
    await context.adapter.client.createComment({
      issueId: context.issue.id,
      body: input.body.trim(),
    });
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

  private async loadIssueContext(id: string): Promise<{
    adapter: LinearPlanningConfigAdapter;
    issue: LinearHydratedIssueRecord;
    record: WorkItemRecord;
  }> {
    const adapter = await this.getConfigAdapter();
    const issue = await adapter.client.getHydratedIssue(id);

    if (issue === null) {
      throw new Error(`Issue '${id}' was not found.`);
    }

    return {
      adapter,
      issue,
      record: mapLinearIssueToWorkItem(issue, adapter),
    };
  }

  private async requireWorkItem(
    id: string,
    adapter: LinearPlanningConfigAdapter,
  ): Promise<WorkItemRecord> {
    const issue = await adapter.client.getHydratedIssue(id);

    if (issue === null) {
      throw new Error(`Issue '${id}' was not found after the Linear mutation.`);
    }

    return mapLinearIssueToWorkItem(issue, adapter);
  }

  private async ensureProviderLabels(
    names: string[],
  ): Promise<Map<string, LinearIssueLabelRecord>> {
    const catalog = await this.getProviderLabelCatalog();
    const missingNames = names.filter(
      (name) => !catalog.has(normalizeLinearLabelName(name)),
    );

    if (missingNames.length === 0) {
      return catalog;
    }

    const adapter = await this.getConfigAdapter();

    for (const name of missingNames) {
      try {
        const created = await adapter.client.createIssueLabel({
          name,
          teamId: adapter.team.id,
          color: "#4A5568",
        });
        catalog.set(normalizeLinearLabelName(created.name), created);
      } catch (error) {
        const refreshedCatalog = await this.reloadProviderLabelCatalog();

        if (refreshedCatalog.has(normalizeLinearLabelName(name))) {
          continue;
        }

        throw error;
      }
    }

    this.providerLabelCatalog = catalog;
    return catalog;
  }

  private async getProviderLabelCatalog(): Promise<Map<string, LinearIssueLabelRecord>> {
    if (this.providerLabelCatalog !== null) {
      return this.providerLabelCatalog;
    }

    if (this.providerLabelCatalogPromise === null) {
      this.providerLabelCatalogPromise = this.reloadProviderLabelCatalog().finally(
        () => {
          this.providerLabelCatalogPromise = null;
        },
      );
    }

    return this.providerLabelCatalogPromise;
  }

  private async reloadProviderLabelCatalog(): Promise<Map<string, LinearIssueLabelRecord>> {
    const adapter = await this.getConfigAdapter();
    const labels = await adapter.client.listIssueLabels({ teamId: adapter.team.id });
    const catalog = new Map<string, LinearIssueLabelRecord>();

    for (const label of labels) {
      if (!label.archived && isLinearProviderOwnedLabel(label.name)) {
        catalog.set(normalizeLinearLabelName(label.name), label);
      }
    }

    this.providerLabelCatalog = catalog;
    return catalog;
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

function assertLeaseHolder(
  record: WorkItemRecord,
  owner: string,
  runId: string,
): void {
  if (!hasActiveLease(record.orchestration.leaseUntil)) {
    throw new Error(`Issue '${record.id}' no longer has an active lease.`);
  }

  if (record.orchestration.owner !== owner) {
    throw new Error(
      `Issue '${record.id}' is owned by '${record.orchestration.owner}', not '${owner}'.`,
    );
  }

  if (record.orchestration.runId !== runId) {
    throw new Error(
      `Issue '${record.id}' is leased to run '${record.orchestration.runId}', not '${runId}'.`,
    );
  }
}

function resolveTransitionPhase(
  nextStatus: WorkItemStatus,
  requestedPhase: WorkPhaseOrNone,
  currentPhase: WorkPhaseOrNone | null,
): WorkPhaseOrNone {
  if (nextStatus === "done" || nextStatus === "canceled" || nextStatus === "backlog") {
    if (requestedPhase !== "none") {
      throw new Error(`Status '${nextStatus}' must use phase 'none'.`);
    }

    return "none";
  }

  if (nextStatus === "blocked") {
    if (currentPhase === null) {
      throw new Error("Blocked transitions require the current issue phase.");
    }

    return currentPhase;
  }

  if (requestedPhase !== nextStatus) {
    throw new Error(
      `Status '${nextStatus}' must use phase '${nextStatus}', not '${requestedPhase}'.`,
    );
  }

  return requestedPhase;
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

function assertValidFutureTimestamp(value: string, label: string): void {
  assertNonEmptyString(value, label);

  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be a valid ISO timestamp.`);
  }

  if (timestamp <= Date.now()) {
    throw new Error(`${label} must be in the future.`);
  }
}
