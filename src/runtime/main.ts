import process from "node:process";
import { fileURLToPath } from "node:url";

import type { LoadedConfig } from "../config/types.js";
import { loadConfig } from "../config/loader.js";
import { RuntimeDaemon } from "./daemon.js";
import {
  RuntimeApiServer,
  resolveRuntimeApiListenOptions,
} from "./api/server.js";

type RuntimeCliOptions = {
  configPath?: string;
  activeProfile?: string;
};

type RuntimeMainDependencies = {
  createRuntimeDaemon?: (loadedConfig: LoadedConfig) => RuntimeDaemon;
  createRuntimeApiServer?: (
    daemon: RuntimeDaemon,
    loadedConfig: LoadedConfig,
  ) => RuntimeApiServer;
  registerSignalHandler?: (
    signal: "SIGINT" | "SIGTERM",
    handler: () => void,
  ) => void;
  setKeepAlive?: typeof setInterval;
  clearKeepAlive?: typeof clearInterval;
  exit?: (code: number) => never;
  log?: (message: string) => void;
};

export type RuntimeService = {
  daemon: RuntimeDaemon;
  apiServer: RuntimeApiServer;
};

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseRuntimeCliArgs(argv);
  const loadedConfig = await loadConfig({
    configPath: options.configPath,
    activeProfile: options.activeProfile,
  });

  await startRuntimeService(loadedConfig);
}

export async function startRuntimeService(
  loadedConfig: LoadedConfig,
  dependencies: RuntimeMainDependencies = {},
): Promise<RuntimeService> {
  const createRuntimeDaemon =
    dependencies.createRuntimeDaemon ?? RuntimeDaemon.fromLoadedConfig;
  const createRuntimeApiServer =
    dependencies.createRuntimeApiServer ??
    ((daemon) =>
      new RuntimeApiServer(
        daemon,
        resolveRuntimeApiListenOptions(daemon.runtimeConfig),
      ));
  const registerSignalHandler =
    dependencies.registerSignalHandler ??
    ((signal, handler) => process.once(signal, handler));
  const setKeepAlive = dependencies.setKeepAlive ?? setInterval;
  const clearKeepAlive = dependencies.clearKeepAlive ?? clearInterval;
  const exit = dependencies.exit ?? process.exit;
  const log = dependencies.log ?? console.log;

  const daemon = createRuntimeDaemon(loadedConfig);
  daemon.start();

  const apiServer = createRuntimeApiServer(daemon, loadedConfig);

  try {
    await apiServer.start();
  } catch (error) {
    await daemon.stop();
    throw error;
  }

  const keepAlive = setKeepAlive(() => undefined, 60_000);
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
    if (shutdownPromise !== null) {
      return shutdownPromise;
    }

    clearKeepAlive(keepAlive);
    shutdownPromise = apiServer
      .stop()
      .catch(() => undefined)
      .then(async () => {
        await daemon.stop();
        log(`Runtime daemon stopped (${signal}).`);
        exit(0);
      });

    return shutdownPromise;
  };

  registerSignalHandler("SIGINT", () => {
    void shutdown("SIGINT");
  });
  registerSignalHandler("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  log(
    `Runtime daemon ready for profile '${loadedConfig.activeProfileName}'. Database: ${daemon.runtimeConfig.databasePath}. API: ${apiServer.info.endpoint}`,
  );

  return {
    daemon,
    apiServer,
  };
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
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
    if (shutdownPromise !== null) {
      return shutdownPromise;
    }

    clearKeepAlive(keepAlive);
    shutdownPromise = daemon.stop().then(() => {
      log(`Runtime daemon stopped (${signal}).`);
      exit(0);
    });
    return shutdownPromise;
  };

  registerSignalHandler("SIGINT", () => {
    void shutdown("SIGINT");
  });
  registerSignalHandler("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

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
