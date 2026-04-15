#!/usr/bin/env node

import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  renderGitHubHelp,
  runGithubCommand,
} from "./cli/github-command.js";
import {
  PromptCommandError,
  renderPromptHelp,
  runPromptCommand,
} from "./cli/prompt-command.js";
import { renderRunHelp, runRunCommand } from "./cli/run-command.js";
import {
  RuntimeCommandError,
  renderRuntimeHelp,
  runRuntimeCommand,
} from "./cli/runtime-command.js";
import {
  SetupCommandError,
  renderSetupHelp,
  runSetupCommand,
} from "./cli/setup-command.js";

export * from "./config/index.js";
export * from "./core/index.js";
export * from "./domain-model.js";
export * from "./orchestrator/index.js";
export * from "./providers/index.js";
export * from "./runtime/index.js";
export * from "./cli/prompt-command.js";
export * from "./cli/prompt-diff.js";
export * from "./cli/prompt-preview.js";
export * from "./cli/prompt-replay.js";
export * from "./cli/run-command.js";
export * from "./cli/runtime-command.js";
export * from "./cli/setup-command.js";
export * from "./diagnostics/failure-diagnosis.js";
export * from "./diagnostics/run-diagnostics.js";
export * from "./cli/github-command.js";
export * from "./github/client.js";
export * from "./github/permission-gate.js";
export * from "./github/runtime-context.js";
export * from "./github/scope.js";

export type CliDependencies = Parameters<typeof runPromptCommand>[1] &
  Parameters<typeof runSetupCommand>[1] &
  Parameters<typeof runGithubCommand>[1] &
  Parameters<typeof runRunCommand>[1] &
  Parameters<typeof runRuntimeCommand>[1] & {
  stderr?: (message: string) => void;
};

export async function runCli(
  argv: string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    (dependencies.stdout ?? console.log)(renderTopLevelHelp());
    return 0;
  }

  const command = argv[0];

  if (command === "init" || command === "bootstrap") {
    return runSetupCommand(argv, dependencies);
  }

  if (command === "prompt") {
    return runPromptCommand(argv.slice(1), dependencies);
  }

  if (command === "run") {
    return runRunCommand(argv.slice(1), dependencies);
  }

  if (command === "runtime") {
    return runRuntimeCommand(argv.slice(1), dependencies);
  }

  if (command === "github") {
    return runGithubCommand(argv.slice(1), dependencies);
  }

  throw new SetupCommandError(`Unknown command '${command}'.`);
}

export async function main(
  argv: string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<void> {
  try {
    const exitCode = await runCli(argv, dependencies);
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } catch (error) {
    const stderr = dependencies.stderr ?? console.error;

    if (error instanceof Error) {
      stderr(error.message);
    } else {
      stderr("CLI execution failed.");
    }

    process.exitCode = 1;
  }
}

export function isDirectExecution(
  entryPath: string | undefined,
  moduleUrl: string = import.meta.url,
  resolveRealPath: (targetPath: string) => string = defaultResolveRealPath,
): boolean {
  if (entryPath === undefined) {
    return false;
  }

  const modulePath = fileURLToPath(moduleUrl);
  return resolveRealPath(entryPath) === resolveRealPath(modulePath);
}

function renderTopLevelHelp(): string {
  return [
    "Usage: orq <command> [options]",
    "",
    "Commands:",
    "  init     Create a starter config.toml from the packaged example config.",
    "  bootstrap Validate the selected profile and prepare local state.",
    "  github   Run bounded GitHub PR interactions inside a managed run.",
    "  prompt   Render and diff resolved prompt variants.",
    "  run      Inspect runtime runs as operator-friendly diagnostics views.",
    "  runtime  Start the runtime daemon from the installed CLI.",
    "",
    renderSetupHelp(),
    "",
    renderGitHubHelp(),
    "",
    renderPromptHelp(),
    "",
    renderRunHelp(),
    "",
    renderRuntimeHelp(),
  ].join("\n");
}

function defaultResolveRealPath(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

if (isDirectExecution(process.argv[1])) {
  void main();
}
