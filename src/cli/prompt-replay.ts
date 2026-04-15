import type { LoadedConfig } from "../config/types.js";
import type {
  PromptProvenanceRecord,
  PromptReplayContextRecord,
} from "../domain-model.js";
import { resolveRuntimeConfig } from "../runtime/config.js";
import { openRuntimeDatabase } from "../runtime/persistence/database.js";
import { RuntimeRepository } from "../runtime/persistence/runtime-repository.js";
import type { ExecutableRunRecord } from "../runtime/types.js";

import { diffPromptPreviews, type PromptDiffResult } from "./prompt-diff.js";
import {
  renderPromptPreview,
  type PromptPreviewResult,
  type PromptPreviewSelectionOverrides,
} from "./prompt-preview.js";

export type PromptReplayContextSource = "replay_snapshot" | "legacy_reconstruction";
export type PromptReplayFidelity = "lossless" | "partial";

export type PromptReplayOptions = {
  runId: string;
  selection?: PromptPreviewSelectionOverrides;
  variantSelection?: PromptPreviewSelectionOverrides;
  cwd?: string;
};

export type PromptReplayRunSummary = {
  runId: string;
  phase: ExecutableRunRecord["phase"];
  provider: ExecutableRunRecord["provider"];
  createdAt: string;
  workItemId: string;
  workItemIdentifier?: string | null;
  promptContractId: string;
  promptDigests: ExecutableRunRecord["promptDigests"];
  databasePath: string;
};

export type PromptReplayResult = {
  historicalRun: PromptReplayRunSummary;
  replayContextSource: PromptReplayContextSource;
  replayFidelity: PromptReplayFidelity;
  replayContext: PromptReplayContextRecord;
  historical: PromptPreviewResult;
  current: PromptPreviewResult;
  diff: PromptDiffResult;
};

export class PromptReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptReplayError";
  }
}

export async function replayPrompt(
  config: LoadedConfig,
  options: PromptReplayOptions,
): Promise<PromptReplayResult> {
  const runtimeConfig = resolveRuntimeConfig(config);
  const database = openRuntimeDatabase(runtimeConfig.databasePath);

  try {
    const repository = new RuntimeRepository(database.connection);
    const historicalRun = repository.getExecutableRun(options.runId);

    if (historicalRun === null) {
      throw new PromptReplayError(
        `Run '${options.runId}' was not found in '${database.path}'.`,
      );
    }

    if (historicalRun.promptProvenance === null) {
      throw new PromptReplayError(
        `Run '${options.runId}' is missing prompt provenance and cannot be replayed.`,
      );
    }

    const provenance = historicalRun.promptProvenance;
    if (provenance === null || provenance === undefined) {
      throw new PromptReplayError(
        `Run '${options.runId}' is missing prompt provenance and cannot be replayed.`,
      );
    }

    const replayContext = recoverReplayContext(historicalRun);
    const historical = buildHistoricalPreview(
      historicalRun,
      provenance,
      replayContext.context,
    );
    const currentSelection = resolveReplaySelection(
      provenance,
      options.selection,
      options.variantSelection,
    );
    const current = await renderPromptPreview(config, {
      role: historicalRun.phase,
      phase: historicalRun.phase,
      selection: currentSelection,
      context: replayContext.context,
      cwd: options.cwd,
      configSourcePath: config.sourcePath,
    });
    const normalizedCurrent =
      replayContext.source === "legacy_reconstruction"
        ? {
            ...current,
            contextSource: "legacy_reconstruction" as const,
          }
        : current;
    const diff = diffPromptPreviews(historical, normalizedCurrent);

    return {
      historicalRun: {
        runId: historicalRun.runId,
        phase: historicalRun.phase,
        provider: historicalRun.provider,
        createdAt: historicalRun.createdAt,
        workItemId: historicalRun.workItemId,
        workItemIdentifier: historicalRun.workItemIdentifier ?? null,
        promptContractId: historicalRun.promptContractId,
        promptDigests: historicalRun.promptDigests,
        databasePath: database.path,
      },
      replayContextSource: replayContext.source,
      replayFidelity: replayContext.fidelity,
      replayContext: replayContext.context,
      historical,
      current: normalizedCurrent,
      diff,
    };
  } finally {
    database.close();
  }
}

function buildHistoricalPreview(
  run: ExecutableRunRecord,
  provenance: PromptProvenanceRecord,
  context: PromptReplayContextRecord,
): PromptPreviewResult {
  return {
    profileName: "historical",
    role: run.phase,
    phase: run.phase,
    context,
    contextSource:
      run.promptReplayContext === null || run.promptReplayContext === undefined
        ? "legacy_reconstruction"
        : "replay_snapshot",
    selection: {
      profileName: "historical",
      promptPackName: provenance.selection.promptPackName,
      capabilities: [...provenance.selection.capabilityNames],
      organizationOverlays: [...provenance.selection.organizationOverlayNames],
      projectOverlays: [...provenance.selection.projectOverlayNames],
      experiment: provenance.selection.experimentName ?? null,
    },
    prompt: run.prompt,
    resolvedLayers: provenance.sources.map((source) => ({
      kind: source.kind,
      ref: source.ref,
      digest: source.digest,
    })),
  };
}

function resolveReplaySelection(
  historical: PromptProvenanceRecord,
  baseOverrides: PromptPreviewSelectionOverrides | undefined,
  variantOverrides: PromptPreviewSelectionOverrides | undefined,
): PromptPreviewSelectionOverrides {
  const mergedBase = {
    promptPackName:
      baseOverrides?.promptPackName ?? historical.selection.promptPackName,
    capabilities:
      baseOverrides?.capabilities === undefined
        ? [...historical.selection.capabilityNames]
        : dedupeStrings(baseOverrides.capabilities),
    experiment:
      baseOverrides?.experiment === undefined
        ? historical.selection.experimentName ?? null
        : baseOverrides.experiment,
    organizationOverlays:
      baseOverrides?.organizationOverlays === undefined
        ? [...historical.selection.organizationOverlayNames]
        : dedupeStrings(baseOverrides.organizationOverlays),
    projectOverlays:
      baseOverrides?.projectOverlays === undefined
        ? [...historical.selection.projectOverlayNames]
        : dedupeStrings(baseOverrides.projectOverlays),
  };

  return {
    promptPackName:
      variantOverrides?.promptPackName ?? mergedBase.promptPackName,
    capabilities:
      variantOverrides?.capabilities === undefined
        ? mergedBase.capabilities
        : dedupeStrings(variantOverrides.capabilities),
    experiment:
      variantOverrides?.experiment === undefined
        ? mergedBase.experiment
        : variantOverrides.experiment,
    organizationOverlays:
      variantOverrides?.organizationOverlays === undefined
        ? mergedBase.organizationOverlays
        : dedupeStrings(variantOverrides.organizationOverlays),
    projectOverlays:
      variantOverrides?.projectOverlays === undefined
        ? mergedBase.projectOverlays
        : dedupeStrings(variantOverrides.projectOverlays),
  };
}

function recoverReplayContext(run: ExecutableRunRecord): {
  context: PromptReplayContextRecord;
  source: PromptReplayContextSource;
  fidelity: PromptReplayFidelity;
} {
  if (run.promptReplayContext !== null && run.promptReplayContext !== undefined) {
    return {
      context: structuredClone(run.promptReplayContext),
      source: "replay_snapshot",
      fidelity: "lossless",
    };
  }

  return {
    context: reconstructLegacyReplayContext(run),
    source: "legacy_reconstruction",
    fidelity: "partial",
  };
}

function reconstructLegacyReplayContext(
  run: ExecutableRunRecord,
): PromptReplayContextRecord {
  const runSection = requireSection(run.prompt.userPrompt, "Run Context");
  const runDescription = extractNestedSection(runSection, "Work Item Description");
  const runFields = parseScalarFields(stripNestedSection(runSection, "Work Item Description"));
  const artifactSection = extractSection(run.prompt.userPrompt, "Artifact Context");
  const artifactFields = artifactSection === null ? null : parseArtifactSection(artifactSection);

  return {
    runId: nullableScalar(runFields.get("Run ID")),
    workItem: {
      id: requireField(runFields, "Work item ID", run.runId),
      identifier:
        nullableScalar(runFields.get("Work item identifier")) ??
        run.workItemIdentifier ??
        null,
      title: requireField(runFields, "Title", run.runId),
      description: runDescription,
      labels: parseList(runFields.get("Labels")),
      url:
        nullableScalar(runFields.get("Work item URL")) ??
        findAttachmentValue(run, "planning_url"),
    },
    artifact:
      artifactFields === null
        ? null
        : {
            artifactId: artifactFields.artifactId,
            url: artifactFields.url,
            summary: artifactFields.summary,
          },
    workspace: {
      repoRoot: requireField(runFields, "Repository root", run.runId),
      workingDir: nullableScalar(runFields.get("Working directory")),
      mode: parseWorkspaceMode(
        requireField(runFields, "Workspace mode", run.runId),
        run.runId,
      ),
      assignedBranch: nullableScalar(runFields.get("Assigned branch")),
      baseBranch: nullableScalar(runFields.get("Base branch")),
      pullRequestUrl:
        nullableScalar(runFields.get("Pull request URL")) ?? null,
      pullRequestMode: nullableScalar(runFields.get("Pull request mode")),
      writeScope: nullableScalar(runFields.get("Write scope")),
    },
    expectations: {
      expectedOutputs: parseOptionalList(runFields.get("Expected outputs")),
      verificationRequired: parseOptionalBoolean(
        runFields.get("Verification required"),
      ),
      requiredRepoChecks: parseOptionalList(runFields.get("Required repo checks")),
      testExpectations: nullableScalar(runFields.get("Test expectations")),
    },
    operatorNote: extractSection(run.prompt.userPrompt, "Operator Note"),
    additionalContext: extractSection(run.prompt.userPrompt, "Additional Context"),
    attachments: structuredClone(run.prompt.attachments),
  };
}

function parseArtifactSection(section: string): {
  artifactId: string;
  url?: string | null;
  summary?: string | null;
} {
  const lines = section.split("\n");
  const fields = parseScalarFields(lines);
  const summary = extractSummary(section);

  return {
    artifactId: requireField(fields, "Artifact ID", "artifact"),
    url:
      nullableScalar(fields.get("Artifact URL")) ??
      null,
    summary,
  };
}

function extractSummary(section: string): string | null {
  const marker = "\nSummary:\n";
  const index = section.indexOf(marker);

  if (index === -1) {
    return null;
  }

  return normalizeSection(section.slice(index + marker.length));
}

function requireSection(prompt: string, title: string): string {
  const section = extractSection(prompt, title);

  if (section === null) {
    throw new PromptReplayError(
      `Prompt replay could not recover the '${title}' section from the historical prompt.`,
    );
  }

  return section;
}

function extractSection(prompt: string, title: string): string | null {
  const startMarker = `## ${title}\n`;
  const start = prompt.indexOf(startMarker);

  if (start === -1) {
    return null;
  }

  const from = start + startMarker.length;
  const next = prompt.indexOf("\n## ", from);
  return normalizeSection(prompt.slice(from, next === -1 ? undefined : next));
}

function extractNestedSection(section: string, title: string): string | null {
  const startMarker = `\n### ${title}\n`;
  const start = section.indexOf(startMarker);

  if (start === -1) {
    return null;
  }

  return normalizeSection(section.slice(start + startMarker.length));
}

function stripNestedSection(section: string, title: string): string[] {
  const startMarker = `\n### ${title}\n`;
  const start = section.indexOf(startMarker);
  const stripped = start === -1 ? section : section.slice(0, start);
  return stripped
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseScalarFields(lines: readonly string[]): Map<string, string> {
  const fields = new Map<string, string>();

  for (const line of lines) {
    const separator = line.indexOf(": ");
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator);
    const value = line.slice(separator + 2);
    fields.set(key, value);
  }

  return fields;
}

function requireField(
  fields: Map<string, string>,
  name: string,
  runId: string,
): string {
  const value = nullableScalar(fields.get(name));
  if (value === null) {
    throw new PromptReplayError(
      `Prompt replay could not recover '${name}' for run '${runId}'.`,
    );
  }

  return value;
}

function nullableScalar(value: string | undefined): string | null {
  if (value === undefined || value === "(none)") {
    return null;
  }

  return value;
}

function parseList(value: string | undefined): string[] {
  const normalized = nullableScalar(value);

  if (normalized === null) {
    return [];
  }

  return normalized
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseOptionalList(value: string | undefined): string[] | undefined {
  const parsed = parseList(value);
  return parsed.length === 0 ? undefined : parsed;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  const normalized = nullableScalar(value);
  if (normalized === null) {
    return undefined;
  }

  if (normalized === "yes") {
    return true;
  }

  if (normalized === "no") {
    return false;
  }

  return undefined;
}

function parseWorkspaceMode(
  value: string,
  runId: string,
): PromptReplayContextRecord["workspace"]["mode"] {
  if (value === "shared_readonly" || value === "ephemeral_worktree") {
    return value;
  }

  throw new PromptReplayError(
    `Prompt replay recovered an unknown workspace mode '${value}' for run '${runId}'.`,
  );
}

function findAttachmentValue(
  run: ExecutableRunRecord,
  kind: "planning_url" | "artifact_url",
): string | null {
  return run.prompt.attachments.find((attachment) => attachment.kind === kind)?.value ?? null;
}

function normalizeSection(value: string): string | null {
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
