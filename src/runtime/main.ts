import process from "node:process";
import { fileURLToPath } from "node:url";

import type { LoadedConfig } from "../config/types.js";
import { loadConfig } from "../config/loader.js";
import { RuntimeDaemon } from "./daemon.js";

type RuntimeCliOptions = {
  configPath?: string;
  activeProfile?: string;
};

type RuntimeMainDependencies = {
  createRuntimeDaemon?: (loadedConfig: LoadedConfig) => RuntimeDaemon;
  registerSignalHandler?: (
    signal: "SIGINT" | "SIGTERM",
    handler: () => void,
  ) => void;
  setKeepAlive?: typeof setInterval;
  clearKeepAlive?: typeof clearInterval;
  exit?: (code: number) => never;
  log?: (message: string) => void;
};

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseRuntimeCliArgs(argv);
  const loadedConfig = await loadConfig({
    configPath: options.configPath,
    activeProfile: options.activeProfile,
  });

  startRuntimeDaemon(loadedConfig);
}

export function startRuntimeDaemon(
  loadedConfig: LoadedConfig,
  dependencies: RuntimeMainDependencies = {},
): RuntimeDaemon {
  const createRuntimeDaemon =
    dependencies.createRuntimeDaemon ?? RuntimeDaemon.fromLoadedConfig;
  const registerSignalHandler =
    dependencies.registerSignalHandler ??
    ((signal, handler) => process.once(signal, handler));
  const setKeepAlive = dependencies.setKeepAlive ?? setInterval;
  const clearKeepAlive = dependencies.clearKeepAlive ?? clearInterval;
  const exit = dependencies.exit ?? process.exit;
  const log = dependencies.log ?? console.log;

  const daemon = createRuntimeDaemon(loadedConfig);
  daemon.start();

  const keepAlive = setKeepAlive(() => undefined, 60_000);
  const shutdown = (signal: "SIGINT" | "SIGTERM"): void => {
    clearKeepAlive(keepAlive);
    daemon.stop();
    log(`Runtime daemon stopped (${signal}).`);
    exit(0);
  };

  registerSignalHandler("SIGINT", () => shutdown("SIGINT"));
  registerSignalHandler("SIGTERM", () => shutdown("SIGTERM"));

  log(
    `Runtime daemon ready for profile '${loadedConfig.activeProfileName}'. Database: ${daemon.runtimeConfig.databasePath}`,
  );

  return daemon;
}

function parseRuntimeCliArgs(argv: string[]): RuntimeCliOptions {
  const options: RuntimeCliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--config") {
      const value = argv[index + 1];

      if (value === undefined) {
        throw new Error("--config requires a value.");
      }

      options.configPath = value;
      index += 1;
      continue;
    }

    if (argument === "--profile") {
      const value = argv[index + 1];

      if (value === undefined) {
        throw new Error("--profile requires a value.");
      }

      options.activeProfile = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown runtime CLI argument '${argument}'.`);
  }

  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error("Runtime daemon failed to start.");
    }

    process.exitCode = 1;
  });
}
