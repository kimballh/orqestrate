import { loadConfig } from "../config/loader.js";
import { WORK_PHASES, type WorkPhase } from "../domain-model.js";

import { diffPromptPreviews } from "./prompt-diff.js";
import { renderPromptPreview, type PromptPreviewResult } from "./prompt-preview.js";
import {
  replayPrompt,
  type PromptReplayResult,
  type PromptReplayOptions as ResolvedPromptReplayOptions,
} from "./prompt-replay.js";

const WORK_PHASE_SET = new Set<string>(WORK_PHASES);

type WriteFn = (message: string) => void;

export type PromptCommandDependencies = {
  cwd?: () => string;
  stdout?: WriteFn;
  stderr?: WriteFn;
  loadConfig?: typeof loadConfig;
};

type PromptCommandFormat = "text" | "json";

type ExplicitSelectionOverrides = {
  promptPackName?: string;
  capabilities: string[];
  experiment?: string | null;
  organizationOverlays?: string[];
  projectOverlays?: string[];
};

type BaseRenderOptions = {
  configPath?: string;
  profile?: string;
  role: WorkPhase;
  phase: WorkPhase;
  contextFilePath?: string;
  format: PromptCommandFormat;
  selection: ExplicitSelectionOverrides;
};

type PromptRenderOptions = BaseRenderOptions;

type PromptDiffOptions = BaseRenderOptions & {
  variantProfile?: string;
  variantContextFilePath?: string;
  variantSelection: {
    promptPackName?: string;
    capabilities?: string[];
    experiment?: string | null;
    organizationOverlays?: string[];
    projectOverlays?: string[];
  };
};

type ReplaySelectionOverrides = {
  promptPackName?: string;
  capabilities?: string[];
  experiment?: string | null;
  organizationOverlays?: string[];
  projectOverlays?: string[];
};

type PromptReplayOptions = {
  configPath?: string;
  profile?: string;
  runId: string;
  format: PromptCommandFormat;
  selection: ReplaySelectionOverrides;
  variantProfile?: string;
  variantSelection: ReplaySelectionOverrides;
};

export class PromptCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptCommandError";
  }
}

export async function runPromptCommand(
  args: string[],
  dependencies: PromptCommandDependencies = {},
): Promise<number> {
  if (args.length === 0 || isHelpFlag(args[0])) {
    write(dependencies.stdout, renderPromptHelp());
    return 0;
  }

  const command = args[0];

  if (command === "render") {
    const options = parseRenderOptions(args.slice(1));

    if (options === "help") {
      write(dependencies.stdout, renderRenderHelp());
      return 0;
    }

    return runRenderCommand(options, dependencies);
  }

  if (command === "diff") {
    const options = parseDiffOptions(args.slice(1));

    if (options === "help") {
      write(dependencies.stdout, renderDiffHelp());
      return 0;
    }

    return runDiffCommand(options, dependencies);
  }

  if (command === "replay") {
    const options = parseReplayOptions(args.slice(1));

    if (options === "help") {
      write(dependencies.stdout, renderReplayHelp());
      return 0;
    }

    return runReplayCommand(options, dependencies);
  }

  throw new PromptCommandError(`Unknown prompt command '${command}'.`);
}

function parseRenderOptions(args: string[]): PromptRenderOptions | "help" {
  const parsed = createBaseOptionAccumulator();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (isHelpFlag(argument)) {
      return "help";
    }

    switch (argument) {
      case "--config":
        parsed.configPath = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--profile":
        parsed.profile = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--role":
        parsed.role = parseWorkPhase(readOptionValue(args, index, argument), argument);
        index += 1;
        break;
      case "--phase":
        parsed.phase = parseWorkPhase(readOptionValue(args, index, argument), argument);
        index += 1;
        break;
      case "--prompt-pack":
        parsed.selection.promptPackName = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--capability":
        parsed.selection.capabilities.push(readOptionValue(args, index, argument));
        index += 1;
        break;
      case "--experiment":
        ensureExclusiveExperimentFlag(parsed.selection.experiment, argument);
        parsed.selection.experiment = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--no-experiment":
        ensureExclusiveExperimentFlag(parsed.selection.experiment, argument);
        parsed.selection.experiment = null;
        break;
      case "--organization-overlay":
        (parsed.selection.organizationOverlays ??= []).push(
          readOptionValue(args, index, argument),
        );
        index += 1;
        break;
      case "--project-overlay":
        (parsed.selection.projectOverlays ??= []).push(
          readOptionValue(args, index, argument),
        );
        index += 1;
        break;
      case "--context-file":
        parsed.contextFilePath = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--format":
        parsed.format = parseFormat(readOptionValue(args, index, argument), argument);
        index += 1;
        break;
      default:
        throw new PromptCommandError(`Unknown prompt render option '${argument}'.`);
    }
  }

  return finalizeBaseOptions(parsed);
}

function parseDiffOptions(args: string[]): PromptDiffOptions | "help" {
  const parsed = createBaseOptionAccumulator();
  const variantSelection: PromptDiffOptions["variantSelection"] = {};
  let variantProfile: string | undefined;
  let variantContextFilePath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (isHelpFlag(argument)) {
      return "help";
    }

    switch (argument) {
      case "--config":
        parsed.configPath = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--profile":
        parsed.profile = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--role":
        parsed.role = parseWorkPhase(readOptionValue(args, index, argument), argument);
        index += 1;
        break;
      case "--phase":
        parsed.phase = parseWorkPhase(readOptionValue(args, index, argument), argument);
        index += 1;
        break;
      case "--prompt-pack":
        parsed.selection.promptPackName = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--capability":
        parsed.selection.capabilities.push(readOptionValue(args, index, argument));
        index += 1;
        break;
      case "--experiment":
        ensureExclusiveExperimentFlag(parsed.selection.experiment, argument);
        parsed.selection.experiment = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--no-experiment":
        ensureExclusiveExperimentFlag(parsed.selection.experiment, argument);
        parsed.selection.experiment = null;
        break;
      case "--organization-overlay":
        (parsed.selection.organizationOverlays ??= []).push(
          readOptionValue(args, index, argument),
        );
        index += 1;
        break;
      case "--project-overlay":
        (parsed.selection.projectOverlays ??= []).push(
          readOptionValue(args, index, argument),
        );
        index += 1;
        break;
      case "--context-file":
        parsed.contextFilePath = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--format":
        parsed.format = parseFormat(readOptionValue(args, index, argument), argument);
        index += 1;
        break;
      case "--variant-profile":
        variantProfile = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--variant-prompt-pack":
        variantSelection.promptPackName = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--variant-capability":
        (variantSelection.capabilities ??= []).push(
          readOptionValue(args, index, argument),
        );
        index += 1;
        break;
      case "--variant-experiment":
        ensureExclusiveExperimentFlag(variantSelection.experiment, argument);
        variantSelection.experiment = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--variant-no-experiment":
        ensureExclusiveExperimentFlag(variantSelection.experiment, argument);
        variantSelection.experiment = null;
        break;
      case "--variant-organization-overlay":
        (variantSelection.organizationOverlays ??= []).push(
          readOptionValue(args, index, argument),
        );
        index += 1;
        break;
      case "--variant-project-overlay":
        (variantSelection.projectOverlays ??= []).push(
          readOptionValue(args, index, argument),
        );
        index += 1;
        break;
      case "--variant-context-file":
        variantContextFilePath = readOptionValue(args, index, argument);
        index += 1;
        break;
      default:
        throw new PromptCommandError(`Unknown prompt diff option '${argument}'.`);
    }
  }

  return {
    ...finalizeBaseOptions(parsed),
    variantProfile,
    variantContextFilePath,
    variantSelection,
  };
}

function parseReplayOptions(args: string[]): PromptReplayOptions | "help" {
  let configPath: string | undefined;
  let profile: string | undefined;
  let runId: string | undefined;
  let format: PromptCommandFormat = "text";
  const selection: ReplaySelectionOverrides = {};
  const variantSelection: ReplaySelectionOverrides = {};
  let variantProfile: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (isHelpFlag(argument)) {
      return "help";
    }

    switch (argument) {
      case "--config":
        configPath = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--profile":
        profile = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--run-id":
        runId = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--prompt-pack":
        selection.promptPackName = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--capability":
        (selection.capabilities ??= []).push(readOptionValue(args, index, argument));
        index += 1;
        break;
      case "--experiment":
        ensureExclusiveExperimentFlag(selection.experiment, argument);
        selection.experiment = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--no-experiment":
        ensureExclusiveExperimentFlag(selection.experiment, argument);
        selection.experiment = null;
        break;
      case "--organization-overlay":
        (selection.organizationOverlays ??= []).push(
          readOptionValue(args, index, argument),
        );
        index += 1;
        break;
      case "--project-overlay":
        (selection.projectOverlays ??= []).push(
          readOptionValue(args, index, argument),
        );
        index += 1;
        break;
      case "--format":
        format = parseFormat(readOptionValue(args, index, argument), argument);
        index += 1;
        break;
      case "--variant-profile":
        variantProfile = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--variant-prompt-pack":
        variantSelection.promptPackName = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--variant-capability":
        (variantSelection.capabilities ??= []).push(
          readOptionValue(args, index, argument),
        );
        index += 1;
        break;
      case "--variant-experiment":
        ensureExclusiveExperimentFlag(variantSelection.experiment, argument);
        variantSelection.experiment = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--variant-no-experiment":
        ensureExclusiveExperimentFlag(variantSelection.experiment, argument);
        variantSelection.experiment = null;
        break;
      case "--variant-organization-overlay":
        (variantSelection.organizationOverlays ??= []).push(
          readOptionValue(args, index, argument),
        );
        index += 1;
        break;
      case "--variant-project-overlay":
        (variantSelection.projectOverlays ??= []).push(
          readOptionValue(args, index, argument),
        );
        index += 1;
        break;
      default:
        throw new PromptCommandError(`Unknown prompt replay option '${argument}'.`);
    }
  }

  if (runId === undefined) {
    throw new PromptCommandError("--run-id is required.");
  }

  return {
    configPath,
    profile,
    runId,
    format,
    selection: finalizeReplaySelection(selection),
    variantProfile,
    variantSelection: finalizeReplaySelection(variantSelection),
  };
}

async function runRenderCommand(
  options: PromptRenderOptions,
  dependencies: PromptCommandDependencies,
): Promise<number> {
  const loadConfigFn = dependencies.loadConfig ?? loadConfig;
  const cwd = dependencies.cwd?.() ?? process.cwd();
  const config = await loadConfigFn({
    cwd,
    configPath: options.configPath,
    activeProfile: options.profile,
  });
  const preview = await renderPromptPreview(config, {
    role: options.role,
    phase: options.phase,
    selection: options.selection,
    contextFilePath: options.contextFilePath,
    cwd,
    configSourcePath: config.sourcePath,
  });

  if (options.format === "json") {
    write(dependencies.stdout, JSON.stringify(preview, null, 2));
    return 0;
  }

  write(dependencies.stdout, formatRenderOutput(preview));
  return 0;
}

async function runDiffCommand(
  options: PromptDiffOptions,
  dependencies: PromptCommandDependencies,
): Promise<number> {
  const loadConfigFn = dependencies.loadConfig ?? loadConfig;
  const cwd = dependencies.cwd?.() ?? process.cwd();
  const leftConfig = await loadConfigFn({
    cwd,
    configPath: options.configPath,
    activeProfile: options.profile,
  });
  const rightProfile = options.variantProfile ?? options.profile;
  const rightConfig =
    rightProfile === undefined || rightProfile === leftConfig.activeProfileName
      ? leftConfig
      : await loadConfigFn({
          cwd,
          configPath: options.configPath,
          activeProfile: rightProfile,
        });
  const leftPreview = await renderPromptPreview(leftConfig, {
    role: options.role,
    phase: options.phase,
    selection: options.selection,
    contextFilePath: options.contextFilePath,
    cwd,
    configSourcePath: leftConfig.sourcePath,
  });
  const rightPreview = await renderPromptPreview(rightConfig, {
    role: options.role,
    phase: options.phase,
    selection: {
      promptPackName:
        options.variantSelection.promptPackName ?? options.selection.promptPackName,
      capabilities:
        options.variantSelection.capabilities ?? options.selection.capabilities,
      experiment:
        options.variantSelection.experiment === undefined
          ? options.selection.experiment
          : options.variantSelection.experiment,
      organizationOverlays:
        options.variantSelection.organizationOverlays ??
        options.selection.organizationOverlays,
      projectOverlays:
        options.variantSelection.projectOverlays ??
        options.selection.projectOverlays,
    },
    contextFilePath:
      options.variantContextFilePath ?? options.contextFilePath,
    cwd,
    configSourcePath: rightConfig.sourcePath,
  });
  const diff = diffPromptPreviews(leftPreview, rightPreview);

  if (options.format === "json") {
    write(dependencies.stdout, JSON.stringify(diff, null, 2));
    return 0;
  }

  write(dependencies.stdout, formatDiffOutput(diff));
  return 0;
}

async function runReplayCommand(
  options: PromptReplayOptions,
  dependencies: PromptCommandDependencies,
): Promise<number> {
  const loadConfigFn = dependencies.loadConfig ?? loadConfig;
  const cwd = dependencies.cwd?.() ?? process.cwd();
  const baseConfig = await loadConfigFn({
    cwd,
    configPath: options.configPath,
    activeProfile: options.profile,
  });
  const variantProfile = options.variantProfile ?? options.profile;
  const variantConfig =
    variantProfile === undefined || variantProfile === baseConfig.activeProfileName
      ? baseConfig
      : await loadConfigFn({
          cwd,
          configPath: options.configPath,
          activeProfile: variantProfile,
        });
  const replay = await replayPrompt(baseConfig, {
    runId: options.runId,
    selection: options.selection,
    variantSelection: options.variantSelection,
    variantConfig,
    cwd,
  } satisfies ResolvedPromptReplayOptions);

  if (options.format === "json") {
    write(dependencies.stdout, JSON.stringify(replay, null, 2));
    return 0;
  }

  write(dependencies.stdout, formatReplayOutput(replay));
  return 0;
}

function createBaseOptionAccumulator(): {
  configPath?: string;
  profile?: string;
  role?: WorkPhase;
  phase?: WorkPhase;
  contextFilePath?: string;
  format: PromptCommandFormat;
  selection: ExplicitSelectionOverrides;
} {
  return {
    format: "text",
    selection: {
      capabilities: [],
    },
  };
}

function finalizeReplaySelection(
  selection: ReplaySelectionOverrides,
): ReplaySelectionOverrides {
  return {
    promptPackName: selection.promptPackName,
    capabilities:
      selection.capabilities === undefined
        ? undefined
        : dedupeStrings(selection.capabilities),
    experiment: selection.experiment,
    organizationOverlays:
      selection.organizationOverlays === undefined
        ? undefined
        : dedupeStrings(selection.organizationOverlays),
    projectOverlays:
      selection.projectOverlays === undefined
        ? undefined
        : dedupeStrings(selection.projectOverlays),
  };
}

function finalizeBaseOptions(
  parsed: ReturnType<typeof createBaseOptionAccumulator>,
): BaseRenderOptions {
  if (parsed.role === undefined) {
    throw new PromptCommandError("--role is required.");
  }

  if (parsed.phase === undefined) {
    throw new PromptCommandError("--phase is required.");
  }

  return {
    configPath: parsed.configPath,
    profile: parsed.profile,
    role: parsed.role,
    phase: parsed.phase,
    contextFilePath: parsed.contextFilePath,
    format: parsed.format,
    selection: {
      promptPackName: parsed.selection.promptPackName,
      capabilities: dedupeStrings(parsed.selection.capabilities),
      experiment: parsed.selection.experiment,
      organizationOverlays:
        parsed.selection.organizationOverlays === undefined
          ? undefined
          : dedupeStrings(parsed.selection.organizationOverlays),
      projectOverlays:
        parsed.selection.projectOverlays === undefined
          ? undefined
          : dedupeStrings(parsed.selection.projectOverlays),
    },
  };
}

function parseWorkPhase(value: string, optionName: string): WorkPhase {
  if (!WORK_PHASE_SET.has(value)) {
    throw new PromptCommandError(
      `${optionName} must be one of ${WORK_PHASES.join(", ")}.`,
    );
  }

  return value as WorkPhase;
}

function parseFormat(value: string, optionName: string): PromptCommandFormat {
  if (value !== "text" && value !== "json") {
    throw new PromptCommandError(`${optionName} must be either 'text' or 'json'.`);
  }

  return value;
}

function readOptionValue(args: string[], index: number, optionName: string): string {
  const value = args[index + 1];

  if (value === undefined || value.startsWith("--")) {
    throw new PromptCommandError(`${optionName} requires a value.`);
  }

  return value;
}

function ensureExclusiveExperimentFlag(
  currentValue: string | null | undefined,
  optionName: string,
): void {
  if (currentValue !== undefined) {
    throw new PromptCommandError(
      `${optionName} conflicts with another experiment-selection flag.`,
    );
  }
}

function isHelpFlag(value: string): boolean {
  return value === "--help" || value === "-h" || value === "help";
}

function formatRenderOutput(result: PromptPreviewResult): string {
  const lines = [
    ...formatPreviewSummary("Selection", result),
    "",
    "Digests",
    `Contract ID: ${result.prompt.contractId}`,
    `System digest: ${result.prompt.digests.system ?? "(none)"}`,
    `User digest: ${result.prompt.digests.user}`,
    "",
    "Sources",
    ...result.resolvedLayers.map((layer) =>
      `- [${layer.kind}] ${layer.ref} digest=${layer.digest}${
        layer.path === undefined ? "" : ` path=${layer.path}`
      }`,
    ),
    "",
    "System Prompt",
    result.prompt.systemPrompt ?? "(none)",
    "",
    "User Prompt",
    result.prompt.userPrompt,
  ];

  return lines.join("\n");
}

function formatDiffOutput(result: ReturnType<typeof diffPromptPreviews>): string {
  const changedSources = result.sourceChanges.filter(
    (entry) => entry.change !== "unchanged",
  );
  const lines = [
    ...formatPreviewSummary("Left", result.left),
    `Contract ID: ${result.left.prompt.contractId}`,
    `System digest: ${result.left.prompt.digests.system ?? "(none)"}`,
    `User digest: ${result.left.prompt.digests.user}`,
    "",
    ...formatPreviewSummary("Right", result.right),
    `Contract ID: ${result.right.prompt.contractId}`,
    `System digest: ${result.right.prompt.digests.system ?? "(none)"}`,
    `User digest: ${result.right.prompt.digests.user}`,
    "",
    "Source Changes",
  ];

  if (changedSources.length === 0) {
    lines.push("No source changes.");
  } else {
    lines.push(
      ...changedSources.map(
        (entry) =>
          `- ${entry.change.toUpperCase()} [${entry.kind}] ${entry.ref} left=${entry.leftDigest ?? "(none)"} right=${entry.rightDigest ?? "(none)"}`,
      ),
    );
  }

  lines.push(
    "",
    "System Prompt Diff",
    result.systemPromptDiff.text,
    "",
    "User Prompt Diff",
    result.userPromptDiff.text,
  );

  return lines.join("\n");
}

function formatPreviewSummary(
  title: string,
  result: PromptPreviewResult,
): string[] {
  return [
    title,
    `Profile: ${result.selection.profileName}`,
    `Role: ${result.role}`,
    `Phase: ${result.phase}`,
    `Prompt pack: ${result.selection.promptPackName}`,
    `Capabilities: ${formatList(result.selection.capabilities)}`,
    `Organization overlays: ${formatList(result.selection.organizationOverlays)}`,
    `Project overlays: ${formatList(result.selection.projectOverlays)}`,
    `Experiment: ${result.selection.experiment ?? "(none)"}`,
    `Context source: ${formatContextSource(result)}`,
  ];
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? "(none)" : values.join(", ");
}

function formatContextSource(result: PromptPreviewResult): string {
  switch (result.contextSource) {
    case "synthetic":
      return "synthetic preview defaults";
    case "context_file":
      return result.contextFilePath ?? "context file";
    case "replay_snapshot":
      return "stored replay snapshot";
    case "legacy_reconstruction":
      return "legacy reconstruction";
  }
}

function formatReplayOutput(result: PromptReplayResult): string {
  const changedSources = result.diff.sourceChanges.filter(
    (entry) => entry.change !== "unchanged",
  );
  const lines = [
    "Historical Run",
    `Run ID: ${result.historicalRun.runId}`,
    `Phase: ${result.historicalRun.phase}`,
    `Provider: ${result.historicalRun.provider}`,
    `Created at: ${result.historicalRun.createdAt}`,
    `Work item ID: ${result.historicalRun.workItemId}`,
    `Work item identifier: ${result.historicalRun.workItemIdentifier ?? "(none)"}`,
    `Prompt contract: ${result.historicalRun.promptContractId}`,
    `Replay context: ${result.replayContextSource === "replay_snapshot" ? "stored snapshot" : "legacy reconstruction"} (${result.replayFidelity})`,
    "",
    ...formatReplaySelectionSummary("Historical Selection", result.historical),
    "",
    ...formatReplaySelectionSummary("Current Selection", result.current),
    "",
    "Source Changes",
  ];

  if (changedSources.length === 0) {
    lines.push("No source changes.");
  } else {
    lines.push(
      ...changedSources.map(
        (entry) =>
          `- ${entry.change.toUpperCase()} [${entry.kind}] ${entry.ref} left=${entry.leftDigest ?? "(none)"} right=${entry.rightDigest ?? "(none)"}`,
      ),
    );
  }

  lines.push(
    "",
    "System Prompt Diff",
    result.diff.systemPromptDiff.text,
    "",
    "User Prompt Diff",
    result.diff.userPromptDiff.text,
  );

  return lines.join("\n");
}

function formatReplaySelectionSummary(
  title: string,
  result: PromptPreviewResult,
): string[] {
  return [
    title,
    `Profile: ${result.selection.profileName}`,
    `Prompt pack: ${result.selection.promptPackName}`,
    `Capabilities: ${formatList(result.selection.capabilities)}`,
    `Organization overlays: ${formatList(result.selection.organizationOverlays)}`,
    `Project overlays: ${formatList(result.selection.projectOverlays)}`,
    `Experiment: ${result.selection.experiment ?? "(none)"}`,
    `Context source: ${formatContextSource(result)}`,
  ];
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function write(writer: WriteFn | undefined, message: string): void {
  (writer ?? console.log)(message);
}

export function renderPromptHelp(): string {
  return [
    "Usage: orq prompt <command> [options]",
    "",
    "Commands:",
    "  render   Render a resolved prompt for a role/phase/profile selection.",
    "  diff     Compare two resolved prompt variants.",
    "  replay   Re-render a stored historical run and compare prompt drift.",
    "",
    renderRenderHelp(),
    "",
    renderDiffHelp(),
    "",
    renderReplayHelp(),
  ].join("\n");
}

function renderRenderHelp(): string {
  return [
    "Render options:",
    "  --config <path>",
    "  --profile <name>",
    "  --role <design|plan|implement|review|merge>",
    "  --phase <design|plan|implement|review|merge>",
    "  --prompt-pack <name>",
    "  --capability <name>            Repeat to include multiple capabilities.",
    "  --experiment <name>",
    "  --no-experiment",
    "  --organization-overlay <name>  Repeat to replace organization overlays.",
    "  --project-overlay <name>       Repeat to replace project overlays.",
    "  --context-file <path>",
    "  --format <text|json>",
  ].join("\n");
}

function renderDiffHelp(): string {
  return [
    "Diff options:",
    "  Base options match 'render', plus:",
    "  --variant-profile <name>",
    "  --variant-prompt-pack <name>",
    "  --variant-capability <name>            Repeat to replace capabilities.",
    "  --variant-experiment <name>",
    "  --variant-no-experiment",
    "  --variant-organization-overlay <name>  Repeat to replace organization overlays.",
    "  --variant-project-overlay <name>       Repeat to replace project overlays.",
    "  --variant-context-file <path>",
  ].join("\n");
}

function renderReplayHelp(): string {
  return [
    "Replay options:",
    "  --config <path>",
    "  --profile <name>",
    "  --run-id <id>",
    "  --prompt-pack <name>",
    "  --capability <name>            Repeat to replace inherited capabilities.",
    "  --experiment <name>",
    "  --no-experiment",
    "  --organization-overlay <name>  Repeat to replace inherited organization overlays.",
    "  --project-overlay <name>       Repeat to replace inherited project overlays.",
    "  --variant-profile <name>",
    "  --variant-prompt-pack <name>",
    "  --variant-capability <name>            Repeat to replace capabilities after base overrides.",
    "  --variant-experiment <name>",
    "  --variant-no-experiment",
    "  --variant-organization-overlay <name>  Repeat to replace organization overlays after base overrides.",
    "  --variant-project-overlay <name>       Repeat to replace project overlays after base overrides.",
    "  --format <text|json>",
  ].join("\n");
}
