import { computeLeaseUntil } from "./identity.js";
import type { PlanningBackend } from "../core/planning-backend.js";
import type { RunStatus } from "../domain-model.js";
import type { RuntimeClient } from "./runtime-client.js";
import type {
  PreparedOrchestrationRun,
  WatchedRunOutcome,
} from "./types.js";

const LIVE_RUNTIME_STATUSES = new Set<RunStatus>([
  "bootstrapping",
  "running",
  "waiting_human",
  "stopping",
]);
const TERMINAL_RUNTIME_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "canceled",
  "stale",
]);

export type WatchRunUntilOutcomeDependencies = {
  runtime: RuntimeClient;
  planning: PlanningBackend;
  now?: () => Date;
  eventPollWaitMs?: number;
  leaseSafetyWindowMs?: number;
};

export async function watchRunUntilOutcome(
  dependencies: WatchRunUntilOutcomeDependencies,
  prepared: PreparedOrchestrationRun,
  initialLastEventSeq: number | null,
): Promise<WatchedRunOutcome> {
  const now = dependencies.now ?? (() => new Date());
  const eventPollWaitMs = dependencies.eventPollWaitMs ?? 1_000;
  const leaseSafetyWindowMs = dependencies.leaseSafetyWindowMs ?? 60_000;
  let lastEventSeq = initialLastEventSeq;
  let leaseUntil = prepared.leaseUntil;
  let markedRunning = false;
  let waitingHumanReason: string | null = null;
  let waitingHumanDetails: string | null = null;

  while (true) {
    const run = await dependencies.runtime.getRun(prepared.runId);

    if (LIVE_RUNTIME_STATUSES.has(run.status)) {
      const nextLeaseUntil = maybeComputeNextLease({
        now: now(),
        leaseUntil,
        leaseDurationMs: prepared.leaseDurationMs,
        leaseSafetyWindowMs,
      });

      if (markedRunning === false) {
        await dependencies.planning.markWorkItemRunning({
          id: prepared.claimedWorkItem.id,
          owner: prepared.owner,
          runId: prepared.runId,
          leaseUntil: nextLeaseUntil,
        });
        markedRunning = true;
        leaseUntil = nextLeaseUntil;
      } else if (nextLeaseUntil !== leaseUntil) {
        await dependencies.planning.renewLease({
          id: prepared.claimedWorkItem.id,
          owner: prepared.owner,
          runId: prepared.runId,
          leaseUntil: nextLeaseUntil,
        });
        leaseUntil = nextLeaseUntil;
      }
    }

    if (run.status === "waiting_human") {
      return {
        run,
        lastEventSeq,
        waitingHumanReason: waitingHumanReason ?? run.waitingHumanReason ?? null,
        waitingHumanDetails,
      };
    }

    if (TERMINAL_RUNTIME_STATUSES.has(run.status)) {
      return {
        run,
        lastEventSeq,
        waitingHumanReason,
        waitingHumanDetails,
      };
    }

    const events = await dependencies.runtime.listRunEvents(prepared.runId, {
      after: lastEventSeq ?? undefined,
      waitMs: eventPollWaitMs,
      limit: 100,
    });

    if (events.length === 0) {
      continue;
    }

    lastEventSeq = events.at(-1)?.seq ?? lastEventSeq;

    for (const event of events) {
      if (event.eventType !== "waiting_human") {
        continue;
      }

      waitingHumanReason = readOptionalString(event.payload.reason);
      waitingHumanDetails = readOptionalString(event.payload.details);
    }
  }
}

function maybeComputeNextLease(input: {
  now: Date;
  leaseUntil: string;
  leaseDurationMs: number;
  leaseSafetyWindowMs: number;
}): string {
  const currentLeaseMs = new Date(input.leaseUntil).getTime();
  if (Number.isFinite(currentLeaseMs) === false) {
    return computeLeaseUntil(input.now, input.leaseDurationMs);
  }

  if (currentLeaseMs - input.now.getTime() > input.leaseSafetyWindowMs) {
    return input.leaseUntil;
  }

  return computeLeaseUntil(input.now, input.leaseDurationMs);
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
