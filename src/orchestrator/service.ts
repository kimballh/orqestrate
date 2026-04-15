import path from "node:path";

import type { AgentProvider } from "../domain-model.js";
import type { LoadedConfig } from "../config/types.js";
import { bootstrapActiveProfile } from "../core/bootstrap.js";

import {
  createOrchestratorOwner,
} from "./identity.js";
import { ReconciliationLoop } from "./reconciliation-loop.js";
import { createRuntimeClient, type RuntimeClient } from "./runtime-client.js";
import { RuntimeApiObserver, type RuntimeObserver } from "./runtime-observer.js";
import { openWakeupDatabase, type WakeupDatabase } from "./wakeup-database.js";
import { WakeupRepository } from "./wakeup-repository.js";
import { WakeupProcessor } from "./wakeup-processor.js";
import { WakeupLoop } from "./wakeup-loop.js";
import { WebhookRouter } from "./webhook-router.js";
import {
  WebhookServer,
  type WebhookListenOptions,
} from "./webhook-server.js";
import type { ContextBackend } from "../core/context-backend.js";
import type { PlanningBackend } from "../core/planning-backend.js";

export type StartOrchestratorServiceOptions = {
  repoRoot: string;
  provider?: AgentProvider;
  owner?: string;
  ownerScope?: string;
  requestedBy?: string | null;
  leaseDurationMs?: number;
  webhookListen?: WebhookListenOptions;
  wakeupIntervalMs?: number;
  now?: () => Date;
};

type StartOrchestratorServiceDependencies = {
  bootstrap?: typeof bootstrapActiveProfile;
  planning?: PlanningBackend;
  context?: ContextBackend;
  runtime?: RuntimeClient;
  runtimeObserver?: RuntimeObserver;
  wakeupDatabase?: WakeupDatabase;
};

export type OrchestratorService = {
  planning: PlanningBackend;
  context: ContextBackend;
  runtime: RuntimeClient;
  runtimeObserver: RuntimeObserver;
  reconciliationLoop: ReconciliationLoop;
  wakeupRepository: WakeupRepository;
  wakeupLoop: WakeupLoop;
  webhookServer: WebhookServer | null;
  stop(): Promise<void>;
};

export async function startOrchestratorService(
  loadedConfig: LoadedConfig,
  options: StartOrchestratorServiceOptions,
  dependencies: StartOrchestratorServiceDependencies = {},
): Promise<OrchestratorService> {
  const bootstrap = dependencies.bootstrap ?? bootstrapActiveProfile;
  const bootstrapped =
    dependencies.planning !== undefined && dependencies.context !== undefined
      ? null
      : await bootstrap(loadedConfig);

  const planning = dependencies.planning ?? bootstrapped?.planning;
  const context = dependencies.context ?? bootstrapped?.context;

  if (planning === undefined || context === undefined) {
    throw new Error("Orchestrator service requires planning and context backends.");
  }

  const runtime = dependencies.runtime ?? createRuntimeClient(loadedConfig);
  const runtimeObserver =
    dependencies.runtimeObserver ?? new RuntimeApiObserver(runtime);
  const owner =
    options.owner ??
    createOrchestratorOwner(options.ownerScope ?? "service");
  const wakeupDatabase =
    dependencies.wakeupDatabase ??
    openWakeupDatabase(
      path.join(loadedConfig.paths.stateDir, "orchestrator.sqlite"),
    );
  const wakeupRepository = new WakeupRepository(wakeupDatabase.connection, {
    now: options.now,
  });
  const wakeupProcessor = new WakeupProcessor({
    planning,
    context,
    loadedConfig,
    runtime,
    repoRoot: options.repoRoot,
    provider: options.provider,
    owner,
    requestedBy: options.requestedBy,
    leaseDurationMs: options.leaseDurationMs,
    now: options.now,
  });
  const wakeupLoop = new WakeupLoop({
    repository: wakeupRepository,
    processor: wakeupProcessor,
    owner,
    intervalMs: options.wakeupIntervalMs,
    now: options.now,
  });
  const reconciliationLoop = new ReconciliationLoop({
    planning,
    context,
    runtimeObserver,
    owner,
    leaseDurationMs: options.leaseDurationMs ?? 15 * 60 * 1000,
    now: options.now,
  });

  const linearSigningSecret = resolveLinearSigningSecret(loadedConfig);
  const webhookServer =
    linearSigningSecret === null
      ? null
      : new WebhookServer(
          new WebhookRouter({
            repository: wakeupRepository,
            linearSigningSecret,
            now: options.now,
          }),
          options.webhookListen ?? {
            host: "127.0.0.1",
            port: 3001,
          },
        );

  wakeupLoop.start();
  reconciliationLoop.start();

  try {
    if (webhookServer !== null) {
      await webhookServer.start();
    }
  } catch (error) {
    wakeupLoop.stop();
    reconciliationLoop.stop();
    wakeupDatabase.close();
    throw error;
  }

  await wakeupLoop.runOnce();

  return {
    planning,
    context,
    runtime,
    runtimeObserver,
    reconciliationLoop,
    wakeupRepository,
    wakeupLoop,
    webhookServer,
    async stop(): Promise<void> {
      wakeupLoop.stop();
      reconciliationLoop.stop();
      await webhookServer?.stop();
      wakeupDatabase.close();
    },
  };
}

function resolveLinearSigningSecret(loadedConfig: LoadedConfig): string | null {
  const provider = loadedConfig.activeProfile.planningProvider;

  if (provider.kind !== "planning.linear") {
    return null;
  }

  if (provider.webhookSigningSecretEnv === undefined) {
    return null;
  }

  return loadedConfig.env[provider.webhookSigningSecretEnv] ?? null;
}
