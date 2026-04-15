import path from "node:path";

import type { LoadedConfig } from "../config/types.js";
import type { ContextBackend } from "../core/context-backend.js";
import type { PlanningBackend } from "../core/planning-backend.js";
import { assemblePrompt } from "../core/prompt-assembly.js";
import type { RunSubmissionPayload } from "../domain-model.js";

import { evaluateClaimability } from "./claimability.js";
import { computeLeaseUntil, createRunId } from "./identity.js";
import { resolvePhase } from "./phase-resolver.js";
import {
  buildBlockedTransition,
  buildRetryableFailureTransition,
  defaultClassifyPostClaimFailure,
} from "./transition-policy.js";
import type {
  ClassifyPostClaimFailure,
  PostClaimFailureContext,
  PrepareClaimedRunInput,
  PrepareClaimedRunResult,
  PreparedRunWorkspace,
} from "./types.js";

const DEFAULT_LEASE_DURATION_MS = 15 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_SEC = 300;
const DEFAULT_BOOTSTRAP_TIMEOUT_SEC = 120;

type PrepareClaimedRunDependencies = {
  planning: PlanningBackend;
  context: ContextBackend;
  config: Pick<
    LoadedConfig,
    "activeProfile" | "policy" | "promptPacks" | "prompts"
  >;
  classifyPostClaimFailure?: ClassifyPostClaimFailure;
};

export async function prepareClaimedRun(
  dependencies: PrepareClaimedRunDependencies,
  input: PrepareClaimedRunInput,
): Promise<PrepareClaimedRunResult> {
  const workItem = await dependencies.planning.getWorkItem(input.workItemId);

  if (workItem === null) {
    throw new Error(`Work item '${input.workItemId}' does not exist.`);
  }

  const now = input.now ?? new Date();
  const resolution = resolvePhase(workItem);
  if (!resolution.actionable) {
    return {
      ok: false,
      workItem,
      resolution,
    };
  }

  const decision = evaluateClaimability(workItem, resolution, now);
  if (!decision.claimable) {
    return {
      ok: false,
      workItem,
      resolution,
      decision,
    };
  }

  const runId = (input.createRunId ?? createRunId)();
  const leaseUntil = computeLeaseUntil(
    now,
    input.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
  );
  const claimedWorkItem = await dependencies.planning.claimWorkItem({
    id: workItem.id,
    phase: resolution.phase,
    owner: input.owner,
    runId,
    leaseUntil,
  });

  const workspace = resolveWorkspace(input.repoRoot, runId, input.workspace);
  const classifyPostClaimFailure =
    dependencies.classifyPostClaimFailure ?? defaultClassifyPostClaimFailure;

  const artifact = await runPostClaimStep(
    dependencies,
    classifyPostClaimFailure,
    {
      claimedWorkItem,
      phase: resolution.phase,
      runId,
      step: "ensure_artifact",
    },
    null,
    () => dependencies.context.ensureArtifact({ workItem: claimedWorkItem }),
  );

  const context = await runPostClaimStep(
    dependencies,
    classifyPostClaimFailure,
    {
      claimedWorkItem,
      phase: resolution.phase,
      runId,
      step: "load_context",
    },
    null,
    () =>
      dependencies.context.loadContextBundle({
        workItem: claimedWorkItem,
        artifact,
        phase: resolution.phase,
      }),
  );

  const resolvedArtifact = context.artifact ?? artifact;
  const runLedger = await runPostClaimStep(
    dependencies,
    classifyPostClaimFailure,
    {
      claimedWorkItem,
      phase: resolution.phase,
      runId,
      step: "create_run_ledger",
    },
    null,
    () =>
      dependencies.context.createRunLedgerEntry({
        runId,
        workItem: claimedWorkItem,
        phase: resolution.phase,
        status: "queued",
      }),
  );
  const prompt = await runPostClaimStep(
    dependencies,
    classifyPostClaimFailure,
    {
      claimedWorkItem,
      phase: resolution.phase,
      runId,
      step: "assemble_prompt",
    },
    runLedger.runId,
    async () =>
      assemblePrompt(dependencies.config, {
        promptPackName: input.prompt?.promptPackName,
        role: resolution.phase,
        phase: resolution.phase,
        capabilities: input.prompt?.capabilities,
        experiment: input.prompt?.experiment,
        runAdditions: input.prompt?.runAdditions,
        context: {
          runId,
          workItem: {
            id: claimedWorkItem.id,
            identifier: claimedWorkItem.identifier ?? null,
            title: claimedWorkItem.title,
            description: claimedWorkItem.description ?? null,
            labels: claimedWorkItem.labels,
            url: claimedWorkItem.url ?? null,
          },
          artifact:
            resolvedArtifact === null
              ? null
              : {
                  artifactId: resolvedArtifact.artifactId,
                  url: resolvedArtifact.url ?? null,
                  summary: resolvedArtifact.summary ?? null,
                },
          workspace: {
            repoRoot: input.repoRoot,
            workingDir: workspace.workingDirHint,
            mode: workspace.mode,
            baseBranch: workspace.baseRef ?? null,
          },
          expectations: input.prompt?.expectations ?? {},
          operatorNote: input.prompt?.operatorNote ?? null,
          additionalContext: joinAdditionalContext(
            context.contextText,
            input.prompt?.additionalContext,
          ),
          attachments: input.prompt?.attachments,
        },
      }),
  );

  const submission = await runPostClaimStep(
    dependencies,
    classifyPostClaimFailure,
    {
      claimedWorkItem,
      phase: resolution.phase,
      runId,
      step: "build_submission",
    },
    runLedger.runId,
    async (): Promise<RunSubmissionPayload> => ({
      runId,
      phase: resolution.phase,
      workItem: {
        id: claimedWorkItem.id,
        identifier: claimedWorkItem.identifier ?? null,
        title: claimedWorkItem.title,
        description: claimedWorkItem.description ?? null,
        labels: claimedWorkItem.labels,
        url: claimedWorkItem.url ?? null,
      },
      artifact:
        resolvedArtifact === null
          ? null
          : {
              artifactId: resolvedArtifact.artifactId,
              url: resolvedArtifact.url ?? null,
              summary: resolvedArtifact.summary ?? null,
            },
      provider: input.provider,
      workspace,
      prompt: prompt.prompt,
      limits: {
        maxWallTimeSec: dependencies.config.policy.defaultPhaseTimeoutSec,
        idleTimeoutSec: DEFAULT_IDLE_TIMEOUT_SEC,
        bootstrapTimeoutSec: DEFAULT_BOOTSTRAP_TIMEOUT_SEC,
      },
      requestedBy: input.requestedBy ?? null,
    }),
  );

  return {
    ok: true,
    prepared: {
      runId,
      owner: input.owner,
      leaseUntil,
      phase: resolution.phase,
      claimedWorkItem,
      artifact: resolvedArtifact,
      context,
      runLedger,
      submission,
    },
    resolution,
    decision,
  };
}

async function runPostClaimStep<T>(
  dependencies: PrepareClaimedRunDependencies,
  classifyPostClaimFailure: ClassifyPostClaimFailure,
  context: PostClaimFailureContext,
  runLedgerId: string | null,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const disposition = classifyPostClaimFailure(error, context);
    if (runLedgerId !== null) {
      await dependencies.context.finalizeRunLedgerEntry({
        runId: runLedgerId,
        status: disposition.kind === "blocked" ? "waiting_human" : "failed",
        summary: buildPreflightFailureSummary(context.step, disposition),
        error: disposition.kind === "blocked" ? disposition.error ?? null : disposition.error,
      });
    }

    await dependencies.planning.transitionWorkItem(
      disposition.kind === "blocked"
        ? buildBlockedTransition({
            workItem: context.claimedWorkItem,
            runId: context.runId,
            blockedReason: disposition.blockedReason,
            error: disposition.error ?? null,
          })
        : buildRetryableFailureTransition({
            workItem: context.claimedWorkItem,
            runId: context.runId,
            error: disposition.error,
          }),
    );
    throw error;
  }
}

function buildPreflightFailureSummary(
  step: PostClaimFailureContext["step"],
  disposition: ReturnType<ClassifyPostClaimFailure>,
): string {
  if (disposition.kind === "blocked") {
    return `Pre-dispatch ${step} blocked: ${disposition.blockedReason}`;
  }

  return `Pre-dispatch ${step} failed: ${disposition.error.message}`;
}

function resolveWorkspace(
  repoRoot: string,
  runId: string,
  workspace: PrepareClaimedRunInput["workspace"],
): PreparedRunWorkspace {
  return {
    repoRoot,
    mode: workspace?.mode ?? "ephemeral_worktree",
    workingDirHint:
      workspace?.workingDirHint ?? path.join(repoRoot, ".worktrees", runId),
    baseRef: workspace?.baseRef ?? null,
  };
}

function joinAdditionalContext(
  contextText: string,
  additionalContext: string | null | undefined,
): string | null {
  const sections = [contextText, additionalContext].filter(
    (value): value is string => value !== undefined && value !== null && value.trim() !== "",
  );

  return sections.length === 0 ? null : sections.join("\n\n");
}
