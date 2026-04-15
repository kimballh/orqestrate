import path from "node:path";

import {
  bootstrapWorkspace,
  initializeWorkspace,
  type BootstrapWorkspaceResult,
  type InitializeWorkspaceResult,
} from "../core/setup.js";

type WriteFn = (message: string) => void;

export type SetupCommandDependencies = {
  cwd?: () => string;
  stdout?: WriteFn;
};

type SetupCommandOptions = {
  cwd?: string;
  configPath?: string;
  profile?: string;
  force: boolean;
};

export class SetupCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupCommandError";
  }
}

export async function runSetupCommand(
  args: string[],
  dependencies: SetupCommandDependencies = {},
): Promise<number> {
  if (args.length === 0 || isHelpFlag(args[0])) {
    write(dependencies.stdout, renderSetupHelp());
    return 0;
  }

  const command = args[0];

  if (command === "init") {
    const options = parseSetupOptions(args.slice(1), "init");

    if (options === "help") {
      write(dependencies.stdout, renderInitHelp());
      return 0;
    }

    const result = await initializeWorkspace({
      cwd: resolveCommandCwd(options.cwd, dependencies.cwd),
      configPath: options.configPath,
      profile: options.profile,
      force: options.force,
      env: {},
    });

    write(dependencies.stdout, formatInitOutput(result));
    return 0;
  }

  if (command === "bootstrap") {
    const options = parseSetupOptions(args.slice(1), "bootstrap");

    if (options === "help") {
      write(dependencies.stdout, renderBootstrapHelp());
      return 0;
    }

    const result = await bootstrapWorkspace({
      cwd: resolveCommandCwd(options.cwd, dependencies.cwd),
      configPath: options.configPath,
      profile: options.profile,
      force: options.force,
    });

    write(dependencies.stdout, formatBootstrapOutput(result, options));
    return 0;
  }

  throw new SetupCommandError(`Unknown setup command '${command}'.`);
}

export function renderSetupHelp(): string {
  return [
    "Setup commands:",
    "  init      Create a starter config.toml from config.example.toml.",
    "  bootstrap Validate the selected profile and prepare local state.",
  ].join("\n");
}

function renderInitHelp(): string {
  return [
    "Init options:",
    "  --config <path>   Target config file path. Defaults to ./config.toml.",
    "  --profile <name>  Active profile to write into the generated config.",
    "  --cwd <path>      Workspace root that contains config.example.toml.",
    "  --force           Overwrite an existing config file.",
  ].join("\n");
}

function renderBootstrapHelp(): string {
  return [
    "Bootstrap options:",
    "  --config <path>   Config file path. Defaults to ./config.toml.",
    "  --profile <name>  Override the active profile for this bootstrap run.",
    "  --cwd <path>      Workspace root for config and local example assets.",
    "  --force           Re-seed the local example roots when applicable.",
  ].join("\n");
}

function parseSetupOptions(
  args: string[],
  commandName: "init" | "bootstrap",
): SetupCommandOptions | "help" {
  const options: SetupCommandOptions = {
    force: false,
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
      case "--cwd":
        options.cwd = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--force":
        options.force = true;
        break;
      default:
        throw new SetupCommandError(
          `Unknown ${commandName} option '${argument}'.`,
        );
    }
  }

  return options;
}

function formatInitOutput(result: InitializeWorkspaceResult): string {
  const configDisplay = displayPath(result.workingDirectory, result.configPath);
  const nextBootstrapCommand =
    result.profileName === "local"
      ? renderBootstrapCommand(result.workingDirectory, result.configPath)
      : `Review ${configDisplay}, replace placeholder credentials, then run: ${renderBootstrapCommand(result.workingDirectory, result.configPath)}`;

  return [
    "Initialization complete.",
    `Config: ${configDisplay}`,
    `Profile: ${result.profileName}`,
    `Source: ${displayPath(result.workingDirectory, result.exampleConfigPath)}`,
    `Overwrite: ${result.overwritten ? "replaced existing file" : "created new file"}`,
    "",
    "Next steps:",
    `  ${nextBootstrapCommand}`,
  ].join("\n");
}

function formatBootstrapOutput(
  result: BootstrapWorkspaceResult,
  options: SetupCommandOptions,
): string {
  const lines = [
    "Bootstrap complete.",
    `Config: ${displayPath(result.workingDirectory, result.configPath)}`,
    `Profile: ${result.profileName}`,
  ];

  if (result.localExample !== null) {
    lines.push(
      `Planning seed: ${result.localExample.planningSeedState}`,
      `Seed issues: ${result.localExample.issueCount}`,
      `Actionable work items: ${result.localExample.actionableCount}`,
    );
  }

  lines.push("", "Checks:");

  for (const check of result.bootstrapReport.checks) {
    lines.push(
      `  ${check.family}: ${check.providerName} (${check.providerKind}) validated=${check.validated ? "yes" : "no"} health=${formatHealthStatus(check.healthCheck?.ok ?? null)}`,
    );
  }

  lines.push("", "Next steps:");
  lines.push(
    `  ${renderRuntimeNextStep(
      result.workingDirectory,
      result.configPath,
      options.profile,
    )}`,
  );

  return lines.join("\n");
}

function renderBootstrapCommand(
  workingDirectory: string,
  configPath: string,
): string {
  if (isDefaultConfigPath(workingDirectory, configPath)) {
    return "npm run orq:bootstrap";
  }

  const parts = ["npx", "tsx", "src/index.ts", "bootstrap", "--config"];
  parts.push(displayPath(workingDirectory, configPath));

  return parts.join(" ");
}

function renderRuntimeNextStep(
  workingDirectory: string,
  configPath: string,
  profileOverride?: string,
): string {
  const parts = ["npx", "tsx", "src/runtime/main.ts"];

  if (
    isDefaultConfigPath(workingDirectory, configPath) &&
    profileOverride === undefined
  ) {
    return "npm run dev";
  }

  if (!isDefaultConfigPath(workingDirectory, configPath)) {
    parts.push("--config", displayPath(workingDirectory, configPath));
  }

  if (profileOverride !== undefined) {
    parts.push("--profile", profileOverride);
  }

  return parts.join(" ");
}

function formatHealthStatus(healthCheckOk: boolean | null): string {
  if (healthCheckOk === null) {
    return "skipped";
  }

  return healthCheckOk ? "ok" : "failed";
}

function resolveCommandCwd(
  cwdArgument: string | undefined,
  cwdProvider: (() => string) | undefined,
): string {
  const baseCwd = cwdProvider?.() ?? process.cwd();
  return cwdArgument === undefined
    ? path.resolve(baseCwd)
    : path.resolve(baseCwd, cwdArgument);
}

function isDefaultConfigPath(workingDirectory: string, configPath: string): boolean {
  return (
    path.basename(configPath) === "config.toml" &&
    path.dirname(configPath) === workingDirectory
  );
}

function displayPath(workingDirectory: string, targetPath: string): string {
  const relativePath = path.relative(workingDirectory, targetPath);
  return relativePath === "" ? "." : relativePath;
}

function readOptionValue(args: string[], index: number, optionName: string): string {
  const value = args[index + 1];

  if (value === undefined) {
    throw new SetupCommandError(`${optionName} requires a value.`);
  }

  return value;
}

function write(stdout: WriteFn | undefined, message: string): void {
  (stdout ?? console.log)(message);
}

function isHelpFlag(argument: string): boolean {
  return argument === "--help" || argument === "-h";
}
