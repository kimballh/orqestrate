import path from "node:path";

import type { LoadedConfig } from "../config/types.js";
import type { ContextBackend } from "../core/context-backend.js";
import type { PlanningBackend } from "../core/planning-backend.js";
import { assemblePrompt } from "../core/prompt-assembly.js";
import type { RunSubmissionPayload } from "../domain-model.js";
import { GitHubCliClient } from "../github/client.js";
import {
  classifyPullRequestReviewLoop,
  renderPullRequestReviewLoopContext,
} from "../github/review-loop.js";
import { parsePullRequestUrl } from "../github/scope.js";

import { evaluateClaimability } from "./claimability.js";
import { computeLeaseUntil, createRunId } from "./identity.js";
import { resolvePhase } from "./phase-resolver.js";
import {
  findLatestReviewLoopRuntimeRun,
  hydrateReviewLoopWorkspace,
  mergeReviewLoopWorkspace,
} from "./review-loop-runtime.js";
import {
  buildBlockedTransition,
  buildRetryableFailureTransition,
  defaultClassifyPostClaimFailure,
} from "./transition-policy.js";
import type { RuntimeObserver } from "./runtime-observer.js";
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
    "activeProfile" | "policy" | "promptCapabilities" | "promptPacks" | "prompts"
  >;
  runtimeObserver?: RuntimeObserver;
  createGitHubClient?: (
    cwd: string,
  ) => Pick<GitHubCliClient, "readPullRequest" | "findOpenPullRequestForBranch">;
  getOriginRemoteUrl?: (cwd: string) => Promise<string>;
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
  const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
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
    leaseDurationMs,
  );
  const claimedWorkItem = await dependencies.planning.claimWorkItem({
    id: workItem.id,
    phase: resolution.phase,
    owner: input.owner,
    runId,
    leaseUntil,
  });

  const recoveredRuntimeRun = await findLatestReviewLoopRuntimeRun(
    dependencies.runtimeObserver,
    claimedWorkItem.id,
  );
  const hydratedWorkspace = await hydrateReviewLoopWorkspace({
    repoRoot: input.repoRoot,
    workspace: mergeReviewLoopWorkspace(
      input.workspace,
      recoveredRuntimeRun?.workspace ?? null,
    ),
    createGitHubClient: (cwd) =>
      dependencies.createGitHubClient?.(cwd) ??
      new GitHubCliClient({ cwd }),
    getOriginRemoteUrl: dependencies.getOriginRemoteUrl,
  });
  const workspace = resolveWorkspace(input.repoRoot, runId, hydratedWorkspace);
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
  const reviewLoop = await runPostClaimStep(
    dependencies,
    classifyPostClaimFailure,
    {
      claimedWorkItem,
      phase: resolution.phase,
      runId,
      step: "load_context",
    },
    null,
    async () => {
      if (
        (resolution.phase !== "implement" && resolution.phase !== "review") ||
        workspace.pullRequestUrl === null ||
        workspace.pullRequestUrl === undefined
      ) {
        return null;
      }

      const client =
        dependencies.createGitHubClient?.(input.repoRoot) ??
        new GitHubCliClient({ cwd: input.repoRoot });
      const pullRequest = parsePullRequestUrl(workspace.pullRequestUrl);
      const pullRequestState = await client.readPullRequest(pullRequest);

      return classifyPullRequestReviewLoop(pullRequestState);
    },
  );
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
    async () => {
      const promptContext = {
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
          assignedBranch: workspace.assignedBranch ?? null,
          baseBranch: workspace.baseRef ?? null,
          pullRequestUrl: workspace.pullRequestUrl ?? null,
          pullRequestMode: workspace.pullRequestMode ?? null,
          writeScope: workspace.writeScope ?? null,
        },
        expectations: input.prompt?.expectations ?? {},
        operatorNote: input.prompt?.operatorNote ?? null,
        additionalContext: joinAdditionalContext(
          context.contextText,
          reviewLoop === null
            ? null
            : renderPullRequestReviewLoopContext({
                phase: resolution.phase as "implement" | "review",
                snapshot: reviewLoop,
              }),
          input.prompt?.additionalContext,
        ),
        attachments: input.prompt?.attachments,
      };

      const requestedCapabilities = mergePromptCapabilities(
        input.prompt?.capabilities,
        reviewLoop === null ? [] : ["github.read_pr"],
      );
      const assembly = await assemblePrompt(dependencies.config, {
        promptPackName: input.prompt?.promptPackName,
        role: resolution.phase,
        phase: resolution.phase,
        capabilities: requestedCapabilities,
        experiment: input.prompt?.experiment,
        runAdditions: input.prompt?.runAdditions,
        context: promptContext,
      });

      return {
        ...assembly,
        replayContext: promptContext,
      };
    },
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
      grantedCapabilities: prompt.grantedCapabilities,
      promptProvenance: prompt.provenance,
      promptReplayContext: prompt.replayContext,
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
      leaseDurationMs,
      phase: resolution.phase,
      claimedWorkItem,
      artifact: resolvedArtifact,
      reviewLoop,
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
    assignedBranch: workspace?.assignedBranch ?? null,
    pullRequestUrl: workspace?.pullRequestUrl ?? null,
    pullRequestMode: workspace?.pullRequestMode ?? null,
    writeScope: workspace?.writeScope ?? null,
  };
}

function joinAdditionalContext(
  ...sectionsInput: Array<string | null | undefined>
): string | null {
  const sections = sectionsInput.filter(
    (value): value is string => value !== undefined && value !== null && value.trim() !== "",
  );

  return sections.length === 0 ? null : sections.join("\n\n");
}

function mergePromptCapabilities(
  requested: string[] | undefined,
  defaults: string[],
): string[] | undefined {
  const merged = [...(requested ?? []), ...defaults];
  const deduped = [...new Set(merged)];
  return deduped.length === 0 ? undefined : deduped;
}
