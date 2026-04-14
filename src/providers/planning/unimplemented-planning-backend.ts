import type { PlanningProviderDefinition } from "../../config/types.js";
import type { WorkItemRecord } from "../../domain-model.js";
import {
  PlanningBackend,
  type AppendCommentInput,
  type ClaimWorkItemInput,
  type ListActionableWorkItemsInput,
  type MarkWorkItemRunningInput,
  type RenewLeaseInput,
  type TransitionWorkItemInput,
} from "../../core/planning-backend.js";

export abstract class UnimplementedPlanningBackend<
  TConfig extends PlanningProviderDefinition,
> extends PlanningBackend<TConfig> {
  constructor(config: TConfig) {
    super(config);
  }

  async validateConfig(): Promise<void> {}

  async listActionableWorkItems(
    _input: ListActionableWorkItemsInput,
  ): Promise<WorkItemRecord[]> {
    return this.unsupportedOperation("listActionableWorkItems");
  }

  async getWorkItem(_id: string): Promise<WorkItemRecord | null> {
    return this.unsupportedOperation("getWorkItem");
  }

  async claimWorkItem(_input: ClaimWorkItemInput): Promise<WorkItemRecord> {
    return this.unsupportedOperation("claimWorkItem");
  }

  async markWorkItemRunning(
    _input: MarkWorkItemRunningInput,
  ): Promise<WorkItemRecord> {
    return this.unsupportedOperation("markWorkItemRunning");
  }

  async renewLease(_input: RenewLeaseInput): Promise<WorkItemRecord> {
    return this.unsupportedOperation("renewLease");
  }

  async transitionWorkItem(
    _input: TransitionWorkItemInput,
  ): Promise<WorkItemRecord> {
    return this.unsupportedOperation("transitionWorkItem");
  }

  async appendComment(_input: AppendCommentInput): Promise<void> {
    return this.unsupportedOperation("appendComment");
  }

  async buildDeepLink(_id: string): Promise<string | null> {
    return this.unsupportedOperation("buildDeepLink");
  }
}
