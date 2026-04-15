import type { ContextBackend } from "../core/context-backend.js";
import type { PlanningBackend } from "../core/planning-backend.js";
import type { WorkItemRecord } from "../domain-model.js";

import { hasExpiredLease, hasActiveLease } from "./claimability.js";
import { renewLeaseIfNeeded } from "./lease-renewer.js";
import { applyRecoveredRuntimeOutcome } from "./outcome-application.js";
import type {
  LeaseObservation,
  ReconciliationClassification,
  ReconciliationResult,
} from "./reconciliation-types.js";
import { isLeaseManagedState, isRuntimeTerminalStatus } from "./run-liveness.js";
import type { ObservedRuntimeRun, RuntimeObserver } from "./runtime-observer.js";

export type ReconcilerDependencies = {
  planning: PlanningBackend;
  context: ContextBackend;
  runtimeObserver: RuntimeObserver;
  owner: string;
  leaseDurationMs: number;
  now?: () => Date;
};

export class Reconciler {
  private readonly planning: PlanningBackend;
  private readonly context: ContextBackend;
  private readonly runtimeObserver: RuntimeObserver;
  private readonly owner: string;
  private readonly leaseDurationMs: number;
  private readonly now: () => Date;

  constructor(dependencies: ReconcilerDependencies) {
    this.planning = dependencies.planning;
    this.context = dependencies.context;
    this.runtimeObserver = dependencies.runtimeObserver;
    this.owner = dependencies.owner;
    this.leaseDurationMs = dependencies.leaseDurationMs;
    this.now = dependencies.now ?? (() => new Date());
  }

  async reconcileLeasedWorkItem(input: {
    workItem: WorkItemRecord;
    runtimeHealthy: boolean;
    observation?: LeaseObservation | null;
  }): Promise<ReconciliationResult> {
    const planningRunId = input.workItem.orchestration.runId ?? null;
    const runtimeRun = planningRunId === null
      ? null
      : await this.runtimeObserver.getRun(planningRunId);
    const classification = classifyPlanningReconciliation({
      workItem: input.workItem,
      runtimeRun,
      runtimeHealthy: input.runtimeHealthy,
      now: this.now(),
    });

    switch (classification.kind) {
      case "planning_active_runtime_active": {
        const renewal = await renewLeaseIfNeeded({
          planning: this.planning,
          workItem: input.workItem,
          runtimeRun,
          runtimeHealthy: input.runtimeHealthy,
          owner: this.owner,
          leaseDurationMs: this.leaseDurationMs,
          observation: input.observation,
          now: this.now(),
        });
        return {
          classification,
          workItem: renewal.workItem,
          renewed: renewal.renewed,
          promotedToRunning: renewal.promotedToRunning,
          handledOutcome: false,
          observation: renewal.decision.observation,
        };
      }
      case "planning_active_runtime_waiting_human":
      case "planning_active_runtime_terminal": {
        const outcome = await applyRecoveredRuntimeOutcome({
          planning: this.planning,
          context: this.context,
          workItem: input.workItem,
          runtimeRun: runtimeRun as ObservedRuntimeRun,
        });
        return {
          classification,
          workItem: outcome.workItem,
          renewed: false,
          promotedToRunning: false,
          handledOutcome: outcome.handled,
          observation: null,
        };
      }
      case "planning_active_runtime_missing_expired_lease": {
        const staleOutcome = await applyRecoveredRuntimeOutcome({
          planning: this.planning,
          context: this.context,
          workItem: input.workItem,
          runtimeRun: {
          runId: input.workItem.orchestration.runId ?? "missing-run",
          workItemId: input.workItem.id,
          workItemIdentifier: input.workItem.identifier ?? null,
          phase: input.workItem.phase === "none" ? "implement" : input.workItem.phase,
          provider: "codex",
            status: "stale",
            repoRoot: "",
            workspace: { mode: "ephemeral_worktree" },
            promptContractId: "recovered/stale",
            promptDigests: { system: null, user: "recovered/stale" },
            limits: {
              maxWallTimeSec: 0,
              idleTimeoutSec: 0,
              bootstrapTimeoutSec: 0,
            },
            outcome: {
              summary:
                "Recovered an expired planning lease without a matching live runtime run.",
              error: {
                providerFamily: "runtime",
                providerKind: "reconciler",
                code: "unavailable",
                message:
                  "Recovered an expired planning lease without a matching live runtime run.",
                retryable: true,
                details: { reconciled: true },
              },
            },
            createdAt: input.workItem.createdAt ?? input.workItem.updatedAt,
            lastEventSeq: null,
            requestedBy: null,
            priority: 100,
            runtimeOwner: "reconciler",
            attemptCount: 1,
            version: 1,
          },
        });
        return {
          classification,
          workItem: staleOutcome.workItem,
          renewed: false,
          promotedToRunning: false,
          handledOutcome: staleOutcome.handled,
          observation: null,
        };
      }
      default:
        return {
          classification,
          workItem: input.workItem,
          renewed: false,
          promotedToRunning: false,
          handledOutcome: false,
          observation:
            runtimeRun === null
              ? null
              : {
                  runId: runtimeRun.runId,
                  workItemId: input.workItem.id,
                  status: runtimeRun.status,
                  leaseUntil: input.workItem.orchestration.leaseUntil ?? null,
                  lastHeartbeatAt: runtimeRun.lastHeartbeatAt ?? null,
                  lastEventSeq: runtimeRun.lastEventSeq,
                  observedAt: this.now().toISOString(),
                },
        };
    }
  }

  async reconcileRuntimeRun(input: {
    runtimeRun: ObservedRuntimeRun;
    runtimeHealthy: boolean;
  }): Promise<ReconciliationResult> {
    const workItem = await this.planning.getWorkItem(input.runtimeRun.workItemId);
    const classification = classifyRuntimeReconciliation({
      workItem,
      runtimeRun: input.runtimeRun,
      runtimeHealthy: input.runtimeHealthy,
      now: this.now(),
    });

    if (
      classification.kind === "runtime_terminal_without_planning_lease" &&
      workItem !== null
    ) {
      const outcome = await applyRecoveredRuntimeOutcome({
        planning: this.planning,
        context: this.context,
        workItem,
        runtimeRun: input.runtimeRun,
      });
      return {
        classification,
        workItem: outcome.workItem,
        renewed: false,
        promotedToRunning: false,
        handledOutcome: outcome.handled,
        observation: null,
      };
    }

    return {
      classification,
      workItem,
      renewed: false,
      promotedToRunning: false,
      handledOutcome: false,
      observation: null,
    };
  }
}

export function classifyPlanningReconciliation(input: {
  workItem: WorkItemRecord;
  runtimeRun: ObservedRuntimeRun | null;
  runtimeHealthy: boolean;
  now: Date;
}): ReconciliationClassification {
  if (!isLeaseManagedState(input.workItem)) {
    return buildClassification("planning_not_leased", input.workItem, input.runtimeRun, input);
  }

  const leaseExpired = hasExpiredLease(input.workItem.orchestration.leaseUntil, input.now);

  if (input.runtimeRun === null) {
    if (!input.runtimeHealthy) {
      return buildClassification(
        "planning_active_runtime_missing_runtime_unhealthy",
        input.workItem,
        null,
        input,
      );
    }

    return buildClassification(
      leaseExpired
        ? "planning_active_runtime_missing_expired_lease"
        : "planning_active_runtime_missing_valid_lease",
      input.workItem,
      null,
      input,
    );
  }

  if (input.runtimeRun.status === "waiting_human") {
    return buildClassification(
      "planning_active_runtime_waiting_human",
      input.workItem,
      input.runtimeRun,
      input,
    );
  }

  if (isRuntimeTerminalStatus(input.runtimeRun.status)) {
    return buildClassification(
      "planning_active_runtime_terminal",
      input.workItem,
      input.runtimeRun,
      input,
    );
  }

  return buildClassification(
    "planning_active_runtime_active",
    input.workItem,
    input.runtimeRun,
    input,
  );
}

export function classifyRuntimeReconciliation(input: {
  workItem: WorkItemRecord | null;
  runtimeRun: ObservedRuntimeRun;
  runtimeHealthy: boolean;
  now: Date;
}): ReconciliationClassification {
  const workItem = input.workItem;

  if (
    workItem !== null &&
    workItem.orchestration.runId === input.runtimeRun.runId &&
    (hasActiveLease(workItem.orchestration.leaseUntil, input.now) ||
      isLeaseManagedState(workItem))
  ) {
    return buildClassification(
      isRuntimeTerminalStatus(input.runtimeRun.status)
        ? "runtime_terminal_without_planning_lease"
        : "planning_active_runtime_active",
      workItem,
      input.runtimeRun,
      input,
    );
  }

  return buildClassification(
    isRuntimeTerminalStatus(input.runtimeRun.status)
      ? "runtime_terminal_orphaned"
      : "runtime_active_orphaned",
    workItem,
    input.runtimeRun,
    input,
  );
}

function buildClassification(
  kind: ReconciliationClassification["kind"],
  workItem: WorkItemRecord | null,
  runtimeRun: ObservedRuntimeRun | null,
  input: {
    runtimeHealthy: boolean;
    now: Date;
    workItem?: WorkItemRecord | null;
  },
): ReconciliationClassification {
  return {
    kind,
    workItem,
    runtimeRun,
    runtimeHealthy: input.runtimeHealthy,
    leaseExpired:
      workItem === null
        ? false
        : hasExpiredLease(workItem.orchestration.leaseUntil, input.now),
  };
}
