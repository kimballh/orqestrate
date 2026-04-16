import process from "node:process";
import { fileURLToPath } from "node:url";

import type { AgentProvider } from "../domain-model.js";
import { loadConfig } from "../config/loader.js";
import type { LoadedConfig } from "../config/types.js";

import {
  startOrchestratorService,
  type OrchestratorService,
} from "./service.js";

export type OrchestratorCliOptions = {
  configPath?: string;
  activeProfile?: string;
  repoRoot: string;
  provider: AgentProvider;
  host?: string;
  port?: number;
};

type OrchestratorMainDependencies = {
  createOrchestratorService?: (
    loadedConfig: LoadedConfig,
    options: Parameters<typeof startOrchestratorService>[1],
  ) => Promise<OrchestratorService>;
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
  const options = parseOrchestratorCliArgs(argv);
  const loadedConfig = await loadConfig({
    configPath: options.configPath,
    activeProfile: options.activeProfile,
  });

  await startOrchestratorMain(loadedConfig, options);
}

export async function startOrchestratorMain(
  loadedConfig: LoadedConfig,
  options: OrchestratorCliOptions,
  dependencies: OrchestratorMainDependencies = {},
): Promise<OrchestratorService> {
  const createOrchestratorService =
    dependencies.createOrchestratorService ?? startOrchestratorService;
  const registerSignalHandler =
    dependencies.registerSignalHandler ??
    ((signal, handler) => process.once(signal, handler));
  const setKeepAlive = dependencies.setKeepAlive ?? setInterval;
  const clearKeepAlive = dependencies.clearKeepAlive ?? clearInterval;
  const exit = dependencies.exit ?? process.exit;
  const log = dependencies.log ?? console.log;

  const service = await createOrchestratorService(loadedConfig, {
    repoRoot: options.repoRoot,
    provider: options.provider,
    webhookListen:
      options.host === undefined && options.port === undefined
        ? undefined
        : {
            host: options.host ?? "127.0.0.1",
            port: options.port ?? 3001,
          },
  });

  const keepAlive = setKeepAlive(() => undefined, 60_000);
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
    if (shutdownPromise !== null) {
      return shutdownPromise;
    }

    clearKeepAlive(keepAlive);
    shutdownPromise = service.stop().then(() => {
      log(`Orchestrator service stopped (${signal}).`);
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
    `Orchestrator service ready for profile '${loadedConfig.activeProfileName}'. Wakeup DB: ${loadedConfig.paths.stateDir}. Webhook: ${service.webhookServer?.info.endpoint ?? "disabled"}`,
  );

  return service;
}

function parseOrchestratorCliArgs(argv: string[]): OrchestratorCliOptions {
  const options: OrchestratorCliOptions = {
    repoRoot: process.cwd(),
    provider: "codex",
  };

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

    if (argument === "--repo-root") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--repo-root requires a value.");
      }
      options.repoRoot = value;
      index += 1;
      continue;
    }

    if (argument === "--provider") {
      const value = argv[index + 1];
      if (value !== "codex" && value !== "claude") {
        throw new Error("--provider must be 'codex' or 'claude'.");
      }
      options.provider = value;
      index += 1;
      continue;
    }

    if (argument === "--host") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--host requires a value.");
      }
      options.host = value;
      index += 1;
      continue;
    }

    if (argument === "--port") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--port requires a value.");
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--port must be a positive integer.");
      }
      options.port = parsed;
      index += 1;
      continue;
    }

    throw new Error(`Unknown orchestrator CLI argument '${argument}'.`);
  }

  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error("Orchestrator service failed to start.");
    }

    process.exitCode = 1;
  });
}
