import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../config/loader.js";
import { RuntimeDaemon } from "./daemon.js";

type RuntimeCliOptions = {
  configPath?: string;
  activeProfile?: string;
};

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseRuntimeCliArgs(argv);
  const loadedConfig = await loadConfig({
    configPath: options.configPath,
    activeProfile: options.activeProfile,
  });
  const daemon = RuntimeDaemon.fromLoadedConfig(loadedConfig);
  const keepAlive = setInterval(() => undefined, 60_000);

  const shutdown = (signal: string): void => {
    clearInterval(keepAlive);
    daemon.stop();
    console.log(`Runtime daemon stopped (${signal}).`);
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  daemon.start();

  console.log(
    `Runtime daemon ready for profile '${loadedConfig.activeProfileName}'. Database: ${daemon.runtimeConfig.databasePath}`,
  );
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
