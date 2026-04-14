import type { PlanningProviderConfig } from "../config/types.js";
import type {
  OrchestrationState,
  ProviderError,
  ReviewOutcome,
  WorkItemRecord,
  WorkItemStatus,
  WorkPhase,
  WorkPhaseOrNone,
} from "../domain-model.js";

import { ProviderBackend } from "./provider-backend.js";

export type ListActionableWorkItemsInput = {
  phases?: WorkPhase[];
  statuses?: WorkItemStatus[];
  limit: number;
};

export type ClaimWorkItemInput = {
  id: string;
  phase: WorkPhase;
  owner: string;
  runId: string;
  leaseUntil: string;
};

export type MarkWorkItemRunningInput = {
  id: string;
  owner: string;
  runId: string;
  leaseUntil: string;
};

export type RenewLeaseInput = {
  id: string;
  owner: string;
  runId: string;
  leaseUntil: string;
};

export type TransitionWorkItemInput = {
  id: string;
  nextStatus: WorkItemStatus;
  nextPhase: WorkPhaseOrNone;
  state: OrchestrationState;
  reviewOutcome?: ReviewOutcome | null;
  blockedReason?: string | null;
  lastError?: ProviderError | null;
  runId?: string | null;
};

export type AppendCommentInput = {
  id: string;
  body: string;
};

export abstract class PlanningBackend<
  TConfig extends PlanningProviderConfig = PlanningProviderConfig,
> extends ProviderBackend<TConfig> {
  abstract listActionableWorkItems(
    input: ListActionableWorkItemsInput,
  ): Promise<WorkItemRecord[]>;

  abstract getWorkItem(id: string): Promise<WorkItemRecord | null>;

  abstract claimWorkItem(input: ClaimWorkItemInput): Promise<WorkItemRecord>;

  abstract markWorkItemRunning(
    input: MarkWorkItemRunningInput,
  ): Promise<WorkItemRecord>;

  abstract renewLease(input: RenewLeaseInput): Promise<WorkItemRecord>;

  abstract transitionWorkItem(
    input: TransitionWorkItemInput,
  ): Promise<WorkItemRecord>;

  abstract appendComment(input: AppendCommentInput): Promise<void>;

  abstract buildDeepLink(id: string): Promise<string | null>;
}
