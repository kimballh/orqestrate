import type { RunStatus, WorkItemRecord } from "../domain-model.js";

import type { ObservedRuntimeRun } from "./runtime-observer.js";

export type LeaseObservation = {
  runId: string;
  workItemId: string;
  status: RunStatus;
  leaseUntil: string | null;
  lastHeartbeatAt: string | null;
  lastEventSeq: number | null;
  observedAt: string;
};

export type LeaseRenewalDecisionReason =
  | "planning_not_leased"
  | "run_missing"
  | "run_id_mismatch"
  | "runtime_unhealthy"
  | "runtime_not_active"
  | "lease_not_due"
  | "no_fresh_evidence"
  | "bootstrap_grace"
  | "fresh_evidence";

export type LeaseRenewalDecision = {
  renew: boolean;
  promoteToRunning: boolean;
  reason: LeaseRenewalDecisionReason;
  nextLeaseUntil: string | null;
  observation: LeaseObservation | null;
};

export type ReconciliationCase =
  | "planning_not_leased"
  | "planning_active_runtime_active"
  | "planning_active_runtime_waiting_human"
  | "planning_active_runtime_terminal"
  | "planning_active_runtime_missing_valid_lease"
  | "planning_active_runtime_missing_expired_lease"
  | "planning_active_runtime_missing_runtime_unhealthy"
  | "runtime_active_orphaned"
  | "runtime_terminal_without_planning_lease";

export type ReconciliationClassification = {
  kind: ReconciliationCase;
  workItem: WorkItemRecord | null;
  runtimeRun: ObservedRuntimeRun | null;
  leaseExpired: boolean;
  runtimeHealthy: boolean;
};

export type ReconciliationResult = {
  classification: ReconciliationClassification;
  workItem: WorkItemRecord | null;
  observation?: LeaseObservation | null;
  renewed: boolean;
  promotedToRunning: boolean;
  handledOutcome: boolean;
};
