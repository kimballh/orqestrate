import process from "node:process";

import { loadConfig } from "../config/loader.js";
import type { AgentProvider } from "../domain-model.js";
import {
  startOrchestratorMain,
  type OrchestratorCliOptions,
} from "../orchestrator/main.js";

type WriteFn = (message: string) => void;

export type OrchestratorCommandDependencies = {
  cwd?: () => string;
  stdout?: WriteFn;
  loadConfig?: typeof loadConfig;
  startOrchestratorMain?: typeof startOrchestratorMain;
};

export class OrchestratorCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorCommandError";
  }
}

export async function runOrchestratorCommand(
  args: string[],
  dependencies: OrchestratorCommandDependencies = {},
): Promise<number> {
  if (args.length === 0 || isHelpFlag(args[0])) {
    write(dependencies.stdout, renderOrchestratorHelp());
    return 0;
  }

  const command = args[0];

  if (command === "start") {
    const options = parseOrchestratorStartOptions(args.slice(1), dependencies.cwd);

    if (options === "help") {
      write(dependencies.stdout, renderOrchestratorStartHelp());
      return 0;
    }

    const loadedConfig = await (dependencies.loadConfig ?? loadConfig)({
      cwd: resolveCommandCwd(dependencies.cwd),
      configPath: options.configPath,
      activeProfile: options.activeProfile,
      env: process.env,
    });

    await (dependencies.startOrchestratorMain ?? startOrchestratorMain)(
      loadedConfig,
      options,
      {
        log: dependencies.stdout,
      },
    );
    return 0;
  }

  throw new OrchestratorCommandError(`Unknown orchestrator command '${command}'.`);
}

export function renderOrchestratorHelp(): string {
  return [
    "Orchestrator commands:",
    "  orchestrator start     Start the orchestrator service for the selected profile.",
  ].join("\n");
}

export function renderOrchestratorStartHelp(): string {
  return [
    "Orchestrator start options:",
    "  --config <path>      Config file path. Defaults to ./config.toml.",
    "  --profile <name>     Override the active profile for this orchestrator process.",
    "  --repo-root <path>   Repository root for execution preparation and git operations.",
    "  --provider <name>    Agent provider to use for claimed work (codex or claude).",
    "  --host <value>       Optional webhook listen host when webhooks are enabled.",
    "  --port <value>       Optional webhook listen port when webhooks are enabled.",
  ].join("\n");
}

function parseOrchestratorStartOptions(
  args: string[],
  cwdProvider: (() => string) | undefined,
): OrchestratorCliOptions | "help" {
  const options: OrchestratorCliOptions = {
    repoRoot: resolveCommandCwd(cwdProvider),
    provider: "codex",
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
        options.activeProfile = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--repo-root":
        options.repoRoot = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--provider":
        options.provider = parseProvider(readOptionValue(args, index, argument));
        index += 1;
        break;
      case "--host":
        options.host = readOptionValue(args, index, argument);
        index += 1;
        break;
      case "--port":
        options.port = parsePort(readOptionValue(args, index, argument));
        index += 1;
        break;
      default:
        throw new OrchestratorCommandError(
          `Unknown orchestrator start option '${argument}'.`,
        );
    }
  }

  return options;
}

function parseProvider(value: string): AgentProvider {
  if (value !== "codex" && value !== "claude") {
    throw new OrchestratorCommandError(
      "--provider must be 'codex' or 'claude'.",
    );
  }

  return value;
}

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new OrchestratorCommandError("--port must be a positive integer.");
  }

  return parsed;
}

function readOptionValue(
  args: string[],
  index: number,
  option: string,
): string {
  const value = args[index + 1];

  if (value === undefined || value.startsWith("-")) {
    throw new OrchestratorCommandError(`${option} requires a value.`);
  }

  return value;
}

function resolveCommandCwd(cwdProvider: (() => string) | undefined): string {
  return (cwdProvider ?? process.cwd)();
}

function write(output: WriteFn | undefined, message: string): void {
  (output ?? console.log)(message);
}

function isHelpFlag(argument: string): boolean {
  return argument === "--help" || argument === "-h";
}
