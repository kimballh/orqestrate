import type { LoadedConfig } from "../config/types.js";
import type { ContextBackend } from "../core/context-backend.js";
import type { PlanningBackend } from "../core/planning-backend.js";
import type { ProviderErrorCode } from "../domain-model.js";
import type { GitHubCliClient } from "../github/client.js";

import { prepareClaimedRun } from "./preparer.js";
import { buildRetryableFailureTransition, toProviderError } from "./transition-policy.js";
import { applyRunOutcome, type ApplyRunOutcomeResult } from "./outcome-writeback.js";
import {
  createRuntimeClient,
  RuntimeApiClientError,
  type RuntimeClient,
} from "./runtime-client.js";
import { RuntimeApiObserver, type RuntimeObserver } from "./runtime-observer.js";
import { watchRunUntilOutcome } from "./runtime-monitor.js";
import type {
  PrepareClaimedRunInput,
  PrepareClaimedRunResult,
  PreparedOrchestrationRun,
  WatchedRunOutcome,
} from "./types.js";

export type ExecutePreparedRunDependencies = {
  planning: PlanningBackend;
  context: ContextBackend;
  loadedConfig: LoadedConfig;
  runtime?: RuntimeClient;
  runtimeObserver?: RuntimeObserver;
  createGitHubClient?: (cwd: string) => Pick<GitHubCliClient, "readPullRequest">;
  now?: () => Date;
  eventPollWaitMs?: number;
  leaseSafetyWindowMs?: number;
};

export type ExecutePreparedRunResult = {
  prepared: PreparedOrchestrationRun;
  watched: WatchedRunOutcome;
  writeback: ApplyRunOutcomeResult;
};

export type ExecuteClaimedRunResult =
  | PrepareClaimedRunResult
  | (Extract<PrepareClaimedRunResult, { ok: true }> & {
      execution: ExecutePreparedRunResult;
    });

export async function executePreparedRun(
  dependencies: ExecutePreparedRunDependencies,
  prepared: PreparedOrchestrationRun,
): Promise<ExecutePreparedRunResult> {
  const runtime =
    dependencies.runtime ?? createRuntimeClient(dependencies.loadedConfig);
  let watched: WatchedRunOutcome;

  try {
    const createResponse = await runtime.createRun(prepared.submission);
    watched = await watchRunUntilOutcome(
      {
        runtime,
        planning: dependencies.planning,
        now: dependencies.now,
        eventPollWaitMs: dependencies.eventPollWaitMs,
        leaseSafetyWindowMs: dependencies.leaseSafetyWindowMs,
      },
      prepared,
      createResponse.run.lastEventSeq,
    );
  } catch (error) {
    const providerError = toProviderError(
      error,
      "runtime",
      "runtime_api",
      mapRuntimeErrorCode(error),
    );
    await dependencies.context.finalizeRunLedgerEntry({
      runId: prepared.runId,
      status: "failed",
      summary: `Run execution failed: ${providerError.message}`,
      error: providerError,
    });
    await dependencies.planning.transitionWorkItem(
      buildRetryableFailureTransition({
        workItem: prepared.claimedWorkItem,
        runId: prepared.runId,
        error: providerError,
      }),
    );
    await dependencies.planning.appendComment({
      id: prepared.claimedWorkItem.id,
      body: [
        `${capitalizePhase(prepared.phase)} run failed before write-back completed.`,
        "",
        providerError.message,
      ].join("\n"),
    });
    throw error;
  }

  const writeback = await applyRunOutcome(
    {
      planning: dependencies.planning,
      context: dependencies.context,
      createGitHubClient: dependencies.createGitHubClient,
    },
    prepared,
    watched,
  );

  return {
    prepared,
    watched,
    writeback,
  };
}

export async function executeClaimedRun(
  dependencies: ExecutePreparedRunDependencies,
  input: PrepareClaimedRunInput,
): Promise<ExecuteClaimedRunResult> {
  const runtime =
    dependencies.runtime ?? createRuntimeClient(dependencies.loadedConfig);
  const runtimeObserver =
    dependencies.runtimeObserver ?? new RuntimeApiObserver(runtime);
  const preparedResult = await prepareClaimedRun(
    {
      planning: dependencies.planning,
      context: dependencies.context,
      config: dependencies.loadedConfig,
      runtimeObserver,
      createGitHubClient: dependencies.createGitHubClient,
    },
    input,
  );

  if (!preparedResult.ok) {
    return preparedResult;
  }

  const execution = await executePreparedRun(
    {
      ...dependencies,
      runtime,
      runtimeObserver,
    },
    preparedResult.prepared,
  );
  return {
    ...preparedResult,
    execution,
  };
}

function mapRuntimeErrorCode(error: unknown): ProviderErrorCode {
  if (!(error instanceof RuntimeApiClientError)) {
    return "unknown";
  }

  switch (error.code) {
    case "timeout":
      return "timeout";
    case "run_not_found":
      return "not_found";
    case "invalid_request":
      return "validation";
    case "invalid_run_state_transition":
      return "conflict";
    case "runtime_not_started":
    case "database_open_failed":
      return "unavailable";
    default:
      return error.status >= 500 ? "transport" : "unknown";
  }
}

function capitalizePhase(phase: PreparedOrchestrationRun["phase"]): string {
  return phase.slice(0, 1).toUpperCase() + phase.slice(1);
}
