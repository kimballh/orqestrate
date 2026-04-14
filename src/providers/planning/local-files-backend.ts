import type { PlanningLocalFilesProviderConfig } from "../../config/types.js";
import {
  type AppendCommentInput,
  type ClaimWorkItemInput,
  type ListActionableWorkItemsInput,
  type MarkWorkItemRunningInput,
  PlanningBackend,
  type RenewLeaseInput,
  type TransitionWorkItemInput,
} from "../../core/planning-backend.js";
import type { WorkItemRecord } from "../../domain-model.js";

import { LocalFilesPlanningStore } from "./local-files-store.js";

export class LocalFilesPlanningBackend extends PlanningBackend<PlanningLocalFilesProviderConfig> {
  private readonly store: LocalFilesPlanningStore;

  constructor(config: PlanningLocalFilesProviderConfig) {
    super(config);
    this.store = new LocalFilesPlanningStore(config);
  }

  async validateConfig(): Promise<void> {
    await this.store.validateConfig();
  }

  async healthCheck() {
    return this.store.healthCheck();
  }

  async listActionableWorkItems(
    input: ListActionableWorkItemsInput,
  ): Promise<WorkItemRecord[]> {
    return this.store.listActionableWorkItems(input);
  }

  async getWorkItem(id: string): Promise<WorkItemRecord | null> {
    return this.store.getWorkItem(id);
  }

  async claimWorkItem(input: ClaimWorkItemInput): Promise<WorkItemRecord> {
    return this.store.claimWorkItem(input);
  }

  async markWorkItemRunning(
    input: MarkWorkItemRunningInput,
  ): Promise<WorkItemRecord> {
    return this.store.markWorkItemRunning(input);
  }

  async renewLease(input: RenewLeaseInput): Promise<WorkItemRecord> {
    return this.store.renewLease(input);
  }

  async transitionWorkItem(
    input: TransitionWorkItemInput,
  ): Promise<WorkItemRecord> {
    return this.store.transitionWorkItem(input);
  }

  async appendComment(input: AppendCommentInput): Promise<void> {
    return this.store.appendComment(input);
  }

  async buildDeepLink(id: string): Promise<string | null> {
    return this.store.buildDeepLink(id);
  }
}
