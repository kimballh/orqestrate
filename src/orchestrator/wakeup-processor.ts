import type { AgentProvider } from "../domain-model.js";
import type { ContextBackend } from "../core/context-backend.js";
import type { PlanningBackend } from "../core/planning-backend.js";
import type { LoadedConfig } from "../config/types.js";

import {
  executeClaimedRun,
  type ExecuteClaimedRunResult,
} from "./execute-run.js";
import type { RuntimeClient } from "./runtime-client.js";
import type { ProcessWakeupResult, WakeupEventRecord } from "./wakeup-types.js";

export type WakeupProcessorDependencies = {
  planning: PlanningBackend;
  context: ContextBackend;
  loadedConfig: LoadedConfig;
  runtime?: RuntimeClient;
  repoRoot: string;
  provider?: AgentProvider;
  owner: string;
  requestedBy?: string | null;
  leaseDurationMs?: number;
  now?: () => Date;
  executeClaimedRunFn?: typeof executeClaimedRun;
};

export class WakeupProcessor {
  private readonly executeClaimedRunFn: typeof executeClaimedRun;
  private readonly provider: AgentProvider;
  private readonly requestedBy: string | null;

  constructor(private readonly dependencies: WakeupProcessorDependencies) {
    this.executeClaimedRunFn =
      dependencies.executeClaimedRunFn ?? executeClaimedRun;
    this.provider = dependencies.provider ?? "codex";
    this.requestedBy = dependencies.requestedBy ?? "orchestrator:wakeup";
  }

  async process(event: WakeupEventRecord): Promise<ProcessWakeupResult> {
    const result = await this.executeClaimedRunFn(
      {
        planning: this.dependencies.planning,
        context: this.dependencies.context,
        loadedConfig: this.dependencies.loadedConfig,
        runtime: this.dependencies.runtime,
        now: this.dependencies.now,
      },
      {
        workItemId: event.issueId,
        provider: this.provider,
        repoRoot: this.dependencies.repoRoot,
        owner: this.dependencies.owner,
        requestedBy: `${this.requestedBy}:${event.deliveryId}`,
        leaseDurationMs: this.dependencies.leaseDurationMs,
        now: this.dependencies.now?.(),
      },
    );

    return mapProcessResult(event, result);
  }
}

function mapProcessResult(
  event: WakeupEventRecord,
  result: ExecuteClaimedRunResult,
): ProcessWakeupResult {
  if (!result.ok) {
    const summary =
      result.decision !== undefined && "message" in result.decision
        ? result.decision.message
        : "message" in result.resolution
          ? result.resolution.message
          : `Wakeup for ${event.issueId} became a no-op.`;

    return {
      eventId: event.eventId,
      outcome: "noop",
      summary,
    };
  }

  return {
    eventId: event.eventId,
    outcome: "executed",
    summary:
      "execution" in result
        ? `Wakeup executed ${result.prepared.claimedWorkItem.id} and observed runtime status '${result.execution.watched.run.status}'.`
        : `Wakeup executed ${result.prepared.claimedWorkItem.id}.`,
  };
}
