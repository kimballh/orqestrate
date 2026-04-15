import { loadConfig } from "../config/loader.js";
import { startRuntimeService } from "../runtime/main.js";

type WriteFn = (message: string) => void;

export type RuntimeCommandDependencies = {
  cwd?: () => string;
  stdout?: WriteFn;
  loadConfig?: typeof loadConfig;
  startRuntimeService?: typeof startRuntimeService;
};

type RuntimeStartOptions = {
  configPath?: string;
  profile?: string;
};

export class RuntimeCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeCommandError";
  }
}

export async function runRuntimeCommand(
  args: string[],
  dependencies: RuntimeCommandDependencies = {},
): Promise<number> {
  if (args.length === 0 || isHelpFlag(args[0])) {
    write(dependencies.stdout, renderRuntimeHelp());
    return 0;
  }

  const command = args[0];

  if (command === "start") {
    const options = parseRuntimeStartOptions(args.slice(1));

    if (options === "help") {
      write(dependencies.stdout, renderRuntimeStartHelp());
      return 0;
    }

    const loadedConfig = await (dependencies.loadConfig ?? loadConfig)({
      cwd: resolveCommandCwd(dependencies.cwd),
      configPath: options.configPath,
      activeProfile: options.profile,
      env: process.env,
    });

    await (dependencies.startRuntimeService ?? startRuntimeService)(loadedConfig, {
      log: dependencies.stdout,
    });
    return 0;
  }

  throw new RuntimeCommandError(`Unknown runtime command '${command}'.`);
}

export function renderRuntimeHelp(): string {
  return [
    "Runtime commands:",
    "  runtime start          Start the runtime daemon and API for the selected profile.",
  ].join("\n");
}

function renderRuntimeStartHelp(): string {
  return [
    "Runtime start options:",
    "  --config <path>   Config file path. Defaults to ./config.toml.",
    "  --profile <name>  Override the active profile for this runtime process.",
  ].join("\n");
}

function parseRuntimeStartOptions(
  args: string[],
): RuntimeStartOptions | "help" {
  const options: RuntimeStartOptions = {};

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
      default:
        throw new RuntimeCommandError(`Unknown runtime start option '${argument}'.`);
    }
  }

  return options;
}

function readOptionValue(
  args: string[],
  index: number,
  option: string,
): string {
  const value = args[index + 1];

  if (value === undefined || value.startsWith("-")) {
    throw new RuntimeCommandError(`${option} requires a value.`);
  }

  return value;
}

function resolveCommandCwd(cwdProvider: (() => string) | undefined): string {
  return (cwdProvider ?? process.cwd)();
}

function write(output: WriteFn | undefined, message: string): void {
  output?.(message);
}

function isHelpFlag(argument: string): boolean {
  return argument === "--help" || argument === "-h";
}
