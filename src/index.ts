#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  PromptCommandError,
  renderPromptHelp,
  runPromptCommand,
} from "./cli/prompt-command.js";

export * from "./config/index.js";
export * from "./core/index.js";
export * from "./domain-model.js";
export * from "./orchestrator/index.js";
export * from "./providers/index.js";
export * from "./runtime/index.js";
export * from "./cli/prompt-command.js";
export * from "./cli/prompt-diff.js";
export * from "./cli/prompt-preview.js";

export type CliDependencies = Parameters<typeof runPromptCommand>[1] & {
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

  if (command === "prompt") {
    return runPromptCommand(argv.slice(1), dependencies);
  }

  throw new PromptCommandError(`Unknown command '${command}'.`);
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

function renderTopLevelHelp(): string {
  return [
    "Usage: orq <command> [options]",
    "",
    "Commands:",
    "  prompt   Render and diff resolved prompt variants.",
    "",
    renderPromptHelp(),
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
