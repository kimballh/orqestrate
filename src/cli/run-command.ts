import path from "node:path";

import { loadConfig } from "../config/loader.js";
import { AGENT_PROVIDERS, RUN_STATUSES, WORK_PHASES } from "../domain-model.js";
import {
  buildRunDiagnostics,
  buildRunListEntry,
  type RunDiagnostics,
  type RunDiagnosticsView,
  type RunListEntry,
} from "../diagnostics/run-diagnostics.js";
import {
  createRuntimeClient,
  type RuntimeClient,
} from "../orchestrator/runtime-client.js";

type WriteFn = (message: string) => void;

export type RunCommandDependencies = {
  cwd?: () => string;
  stdout?: WriteFn;
  loadConfig?: typeof loadConfig;
  createRuntimeClient?: (
    ...args: Parameters<typeof createRuntimeClient>
  ) => RuntimeClient;
};

type RunCommandFormat = "text" | "json";

type SharedRunCommandOptions = {
  configPath?: string;
  profile?: string;
  format: RunCommandFormat;
};

type RunListOptions = SharedRunCommandOptions & {
  status?: (typeof RUN_STATUSES)[number];
  provider?: (typeof AGENT_PROVIDERS)[number];
  phase?: (typeof WORK_PHASES)[number];
  workItem?: string;
  limit: number;
};

type RunInspectOptions = SharedRunCommandOptions & {
  runId: string;
  view: RunDiagnosticsView;
  eventsLimit: number;
};

export class RunCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunCommandError";
  }
}

export async function runRunCommand(
  args: string[],
  dependencies: RunCommandDependencies = {},
): Promise<number> {
  if (args.length === 0 || isHelpFlag(args[0])) {
    write(dependencies.stdout, renderRunHelp());
    return 0;
  }

  const command = args[0];

  if (command === "list") {
    const options = parseRunListOptions(args.slice(1));
    if (options === "help") {
      write(dependencies.stdout, renderRunListHelp());
      return 0;
    }

    return runListCommand(options, dependencies);
  }

  if (command === "inspect") {
    const options = parseRunInspectOptions(args.slice(1));
    if (options === "help") {
      write(dependencies.stdout, renderRunInspectHelp());
      return 0;
    }

    return runInspectCommand(options, dependencies);
  }

  throw new RunCommandError(`Unknown run command '${command}'.`);
}

export function renderRunHelp(): string {
  return [
    "Run commands:",
    "  run list                 List recent runtime runs with operator-friendly summaries.",
    "  run inspect <run-id>     Inspect one run as overview, timeline, prompt, and failure views.",
  ].join("\n");
}

function renderRunListHelp(): string {
  return [
    "Run list options:",
    "  --config <path>    Config file path. Defaults to ./config.toml.",
    "  --profile <name>   Override the active profile for this command.",
    "  --format <value>   text or json. Defaults to text.",
    "  --status <value>   Filter by run status.",
    "  --provider <value> Filter by provider.",
    "  --phase <value>    Filter by work phase.",
    "  --work-item <id>   Filter by work item id or identifier.",
    "  --limit <n>        Maximum runs to show. Defaults to 20.",
  ].join("\n");
}

function renderRunInspectHelp(): string {
  return [
    "Run inspect options:",
    "  --config <path>       Config file path. Defaults to ./config.toml.",
    "  --profile <name>      Override the active profile for this command.",
    "  --format <value>      text or json. Defaults to text.",
    "  --view <value>        overview, timeline, prompt, failure, or full. Defaults to full.",
    "  --events-limit <n>    Maximum event history to fetch. Defaults to 200.",
  ].join("\n");
}

async function runListCommand(
  options: RunListOptions,
  dependencies: RunCommandDependencies,
): Promise<number> {
  const client = await resolveRuntimeClient(options, dependencies);
  const response = await listRunsForFilters(client, options);

  const entries = response.runs.map((run) => buildRunListEntry(run));
  const output =
    options.format === "json"
      ? JSON.stringify(
          {
            filters: {
              status: options.status ?? null,
              provider: options.provider ?? null,
              phase: options.phase ?? null,
              workItem: options.workItem ?? null,
              limit: options.limit,
            },
            runs: entries,
            nextCursor: response.nextCursor ?? null,
          },
          null,
          2,
        )
      : renderRunList(entries, options);

  write(dependencies.stdout, output);
  return 0;
}

async function runInspectCommand(
  options: RunInspectOptions,
  dependencies: RunCommandDependencies,
): Promise<number> {
  const client = await resolveRuntimeClient(options, dependencies);
  const [run, events] = await Promise.all([
    client.getRun(options.runId),
    fetchLatestRunEvents(client, options.runId, options.eventsLimit),
  ]);
  const diagnostics = buildRunDiagnostics(run, events);

  const output =
    options.format === "json"
      ? JSON.stringify(
          {
            view: options.view,
            diagnostics,
          },
          null,
          2,
        )
      : renderRunInspect(diagnostics, options.view);

  write(dependencies.stdout, output);
  return 0;
}

async function resolveRuntimeClient(
  options: SharedRunCommandOptions,
  dependencies: RunCommandDependencies,
): Promise<RuntimeClient> {
  const cwd = resolveCommandCwd(dependencies.cwd);
  const loadedConfig = await (dependencies.loadConfig ?? loadConfig)({
    cwd,
    configPath: options.configPath,
    activeProfile: options.profile,
    env: process.env,
  });

  return (dependencies.createRuntimeClient ?? createRuntimeClient)(loadedConfig);
}

async function listRunsForFilters(
  client: RuntimeClient,
  options: RunListOptions,
): Promise<{ runs: Awaited<ReturnType<RuntimeClient["getRun"]>>[]; nextCursor: string | null }> {
  if (options.workItem === undefined) {
    const response = await client.listRuns({
      status: options.status,
      provider: options.provider,
      phase: options.phase,
      limit: options.limit,
    });
    return {
      runs: response.runs,
      nextCursor: response.nextCursor ?? null,
    };
  }

  const filteredById = await client.listRuns({
    status: options.status,
    provider: options.provider,
    phase: options.phase,
    workItemId: options.workItem,
    limit: options.limit,
  });

  if (filteredById.runs.length > 0) {
    return {
      runs: filteredById.runs,
      nextCursor: filteredById.nextCursor ?? null,
    };
  }

  const matchedRuns: Awaited<ReturnType<RuntimeClient["getRun"]>>[] = [];
  const seenRunIds = new Set<string>();
  let cursor: string | null = null;

  do {
    const response = await client.listRuns({
      status: options.status,
      provider: options.provider,
      phase: options.phase,
      limit: Math.max(options.limit, 100),
      cursor: cursor ?? undefined,
    });

    for (const run of response.runs) {
      if (run.workItemIdentifier !== options.workItem || seenRunIds.has(run.runId)) {
        continue;
      }

      matchedRuns.push(run);
      seenRunIds.add(run.runId);
      if (matchedRuns.length === options.limit) {
        return {
          runs: matchedRuns,
          nextCursor: response.nextCursor ?? null,
        };
      }
    }

    cursor = response.nextCursor ?? null;
  } while (cursor !== null);

  return {
    runs: matchedRuns,
    nextCursor: null,
  };
}

async function fetchLatestRunEvents(
  client: RuntimeClient,
  runId: string,
  eventsLimit: number,
): Promise<Awaited<ReturnType<RuntimeClient["listRunEvents"]>>> {
  const pageSize = eventsLimit;
  const latestEvents: Awaited<ReturnType<RuntimeClient["listRunEvents"]>> = [];
  let after = 0;

  while (true) {
    const page = await client.listRunEvents(runId, {
      after,
      limit: pageSize,
      waitMs: 0,
    });

    if (page.length === 0) {
      break;
    }

    latestEvents.push(...page);
    if (latestEvents.length > eventsLimit) {
      latestEvents.splice(0, latestEvents.length - eventsLimit);
    }

    after = page.at(-1)?.seq ?? after;
    if (page.length < pageSize) {
      break;
    }
  }

  return latestEvents;
}

function renderRunList(entries: RunListEntry[], options: RunListOptions): string {
  const lines = ["Recent Runs"];

  const activeFilters = [
    options.status ? `status=${options.status}` : null,
    options.provider ? `provider=${options.provider}` : null,
    options.phase ? `phase=${options.phase}` : null,
    options.workItem ? `workItem=${options.workItem}` : null,
    `limit=${options.limit}`,
  ].filter((value): value is string => value !== null);
  lines.push(`Filters: ${activeFilters.join(", ")}`);
  lines.push("");

  if (entries.length === 0) {
    lines.push("No runs matched the requested filters.");
    return lines.join("\n");
  }

  for (const entry of entries) {
    lines.push(
      `${entry.runId} | ${entry.workItemIdentifier ?? entry.workItemId} | ${entry.phase} | ${entry.provider} | ${entry.status} | ${entry.createdAt}`,
    );
    lines.push(`  ${entry.headline}`);
  }

  return lines.join("\n");
}

function renderRunInspect(
  diagnostics: RunDiagnostics,
  view: RunDiagnosticsView,
): string {
  const sections: string[] = [];

  if (view === "full" || view === "overview") {
    sections.push(renderOverviewSection(diagnostics));
  }
  if (view === "full" || view === "timeline") {
    sections.push(renderTimelineSection(diagnostics));
  }
  if (view === "full" || view === "prompt") {
    sections.push(renderPromptSection(diagnostics));
  }
  if (view === "full" || view === "failure") {
    sections.push(renderFailureSection(diagnostics));
  }

  return sections.join("\n\n");
}

function renderOverviewSection(diagnostics: RunDiagnostics): string {
  const { run, overview } = diagnostics;
  const lines = [
    "Overview",
    `Run ID: ${run.runId}`,
    `Work Item: ${run.workItemIdentifier ?? run.workItemId}`,
    `Phase: ${run.phase}`,
    `Provider: ${run.provider}`,
    `Status: ${run.status}`,
    `Headline: ${overview.headline}`,
    `Prompt Contract: ${run.promptContractId}`,
    `Capabilities: ${joinOrNone(run.grantedCapabilities)}`,
    `Created At: ${run.createdAt}`,
    `Last Meaningful Event At: ${overview.lastMeaningfulEventAt ?? "none"}`,
    `Last Event Seq: ${overview.lastEventSeq ?? "none"}`,
    `Queue Duration: ${formatDuration(overview.queueDurationMs)}`,
    `Launch Duration: ${formatDuration(overview.launchDurationMs)}`,
    `Execution Duration: ${formatDuration(overview.executionDurationMs)}`,
  ];

  return lines.join("\n");
}

function renderTimelineSection(diagnostics: RunDiagnostics): string {
  const lines = ["Timeline"];
  lines.push(
    `Milestones: enqueued=${diagnostics.timeline.milestones.enqueuedAt ?? "none"}, admitted=${diagnostics.timeline.milestones.admittedAt ?? "none"}, started=${diagnostics.timeline.milestones.startedAt ?? "none"}, ready=${diagnostics.timeline.milestones.readyAt ?? "none"}, completed=${diagnostics.timeline.milestones.completedAt ?? "none"}`,
  );
  lines.push("");

  if (diagnostics.timeline.entries.length === 0) {
    lines.push("No events recorded.");
    return lines.join("\n");
  }

  for (const entry of diagnostics.timeline.entries) {
    lines.push(
      `${entry.seq}. ${entry.occurredAt} [${entry.level}/${entry.source}] ${entry.eventType} - ${entry.summary}`,
    );
  }

  return lines.join("\n");
}

function renderPromptSection(diagnostics: RunDiagnostics): string {
  const prompt = diagnostics.prompt;
  const selection = prompt.selection;
  const rendered = prompt.rendered;
  const lines = [
    "Prompt Provenance",
    `Contract ID: ${prompt.contractId}`,
    `Capabilities: ${joinOrNone(prompt.grantedCapabilities)}`,
    `Status: ${prompt.status}`,
  ];

  if (prompt.note !== null) {
    lines.push(`Note: ${prompt.note}`);
  }

  if (selection !== null) {
    lines.push(`Prompt Pack: ${selection.promptPackName}`);
    lines.push(
      `Selection: capabilities=${joinOrNone(selection.capabilityNames)}, orgOverlays=${joinOrNone(selection.organizationOverlayNames)}, projectOverlays=${joinOrNone(selection.projectOverlayNames)}, experiment=${selection.experimentName ?? "none"}`,
    );
  }

  if (rendered !== null) {
    lines.push(
      `Rendered: systemChars=${rendered.systemPromptLength}, userChars=${rendered.userPromptLength}, attachments=${rendered.attachmentCount}, attachmentKinds=${joinOrNone(rendered.attachmentKinds)}`,
    );
  }

  lines.push("Sources:");
  if (prompt.sources.length === 0) {
    lines.push("  none");
  } else {
    for (const source of prompt.sources) {
      lines.push(`  ${source.kind} | ${source.ref} | ${source.digest}`);
    }
  }

  return lines.join("\n");
}

function renderFailureSection(diagnostics: RunDiagnostics): string {
  const failure = diagnostics.failure;
  const lines = [
    "Failure Analysis",
    `Category: ${failure.category}`,
    `Headline: ${failure.headline ?? "none"}`,
    `Explanation: ${failure.explanation ?? "none"}`,
    `Related Events: ${joinOrNone(failure.relatedEventTypes)}`,
    "Likely Causes:",
  ];

  if (failure.likelyCauses.length === 0) {
    lines.push("  none");
  } else {
    for (const cause of failure.likelyCauses) {
      lines.push(`  - ${cause}`);
    }
  }

  lines.push("Recommended Actions:");
  if (failure.recommendedActions.length === 0) {
    lines.push("  none");
  } else {
    for (const action of failure.recommendedActions) {
      lines.push(`  - ${action}`);
    }
  }

  return lines.join("\n");
}

function parseRunListOptions(args: string[]): RunListOptions | "help" {
  const options: RunListOptions = {
    format: "text",
    limit: 20,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (isHelpFlag(argument)) {
      return "help";
    }

    switch (argument) {
      case "--config":
        options.configPath = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--profile":
        options.profile = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--format":
        options.format = parseFormat(readOptionValue(args, index, argument), argument);
        index += 1;
        break;
      case "--status":
        options.status = parseValue(
          readOptionValue(args, index, argument),
          RUN_STATUSES,
          argument,
        );
        index += 1;
        break;
      case "--provider":
        options.provider = parseValue(
          readOptionValue(args, index, argument),
          AGENT_PROVIDERS,
          argument,
        );
        index += 1;
        break;
      case "--phase":
        options.phase = parseValue(
          readOptionValue(args, index, argument),
          WORK_PHASES,
          argument,
        );
        index += 1;
        break;
      case "--work-item":
        options.workItem = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--limit":
        options.limit = parsePositiveInteger(
          readOptionValue(args, index, argument),
          argument,
        );
        index += 1;
        break;
      default:
        throw new RunCommandError(`Unknown run list option '${argument}'.`);
    }
  }

  return options;
}

function parseRunInspectOptions(args: string[]): RunInspectOptions | "help" {
  let runId: string | undefined;
  const options: Omit<RunInspectOptions, "runId"> = {
    format: "text",
    view: "full",
    eventsLimit: 200,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (isHelpFlag(argument)) {
      return "help";
    }

    if (!argument.startsWith("--")) {
      if (runId !== undefined) {
        throw new RunCommandError("Run inspect accepts exactly one run id.");
      }
      runId = argument;
      continue;
    }

    switch (argument) {
      case "--config":
        options.configPath = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--profile":
        options.profile = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--format":
        options.format = parseFormat(readOptionValue(args, index, argument), argument);
        index += 1;
        break;
      case "--view":
        options.view = parseValue(
          readOptionValue(args, index, argument),
          ["overview", "timeline", "prompt", "failure", "full"] as const,
          argument,
        );
        index += 1;
        break;
      case "--events-limit":
        options.eventsLimit = parsePositiveInteger(
          readOptionValue(args, index, argument),
          argument,
        );
        index += 1;
        break;
      default:
        throw new RunCommandError(`Unknown run inspect option '${argument}'.`);
    }
  }

  if (runId === undefined) {
    throw new RunCommandError("Run inspect requires a run id.");
  }

  return {
    ...options,
    runId,
  };
}

function resolveCommandCwd(cwdProvider: (() => string) | undefined): string {
  return path.resolve(cwdProvider?.() ?? process.cwd());
}

function isHelpFlag(argument: string): boolean {
  return argument === "--help" || argument === "-h";
}

function readOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new RunCommandError(`Option '${flag}' requires a value.`);
  }

  return value;
}

function parseFormat(value: string, flag: string): RunCommandFormat {
  if (value === "text" || value === "json") {
    return value;
  }

  throw new RunCommandError(
    `Option '${flag}' must be one of: text, json.`,
  );
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RunCommandError(`Option '${flag}' must be a positive integer.`);
  }

  return parsed;
}

function parseValue<T extends readonly string[]>(
  value: string,
  allowedValues: T,
  flag: string,
): T[number] {
  if ((allowedValues as readonly string[]).includes(value)) {
    return value as T[number];
  }

  throw new RunCommandError(
    `Option '${flag}' must be one of: ${allowedValues.join(", ")}.`,
  );
}

function joinOrNone(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return "n/a";
  }

  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  if (durationMs < 60_000) {
    return `${(durationMs / 1_000).toFixed(1)}s`;
  }

  return `${(durationMs / 60_000).toFixed(1)}m`;
}

function write(writer: WriteFn | undefined, message: string): void {
  (writer ?? console.log)(message);
}
