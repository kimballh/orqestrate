import type {
  ContextProviderConfig,
  LoadedConfig,
  PlanningProviderConfig,
} from "../config/types.js";
import { createBuiltinProviderRegistry } from "../providers/builtins.js";

import type { ContextBackend } from "./context-backend.js";
import {
  ProviderBootstrapError,
  type ProviderRegistrationSource,
} from "./errors.js";
import type { PlanningBackend } from "./planning-backend.js";
import type {
  ProviderFactoryContext,
  ProviderRegistry,
  RegisteredContextProvider,
  RegisteredPlanningProvider,
} from "./provider-registry.js";
import type { ProviderHealthCheckResult } from "./provider-backend.js";

export type BootstrapCheck = {
  family: "planning" | "context";
  providerName: string;
  providerKind: string;
  source: ProviderRegistrationSource;
  validated: boolean;
  healthCheck: ProviderHealthCheckResult | null;
};

export type BootstrapReport = {
  profileName: string;
  checks: [BootstrapCheck, BootstrapCheck];
};

export type BootstrapResult = {
  planning: PlanningBackend;
  context: ContextBackend;
  report: BootstrapReport;
};

export type BootstrapOptions = {
  registry?: ProviderRegistry;
  runHealthChecks?: boolean;
};

export async function bootstrapActiveProfile(
  loadedConfig: LoadedConfig,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const registry = options.registry ?? createBuiltinProviderRegistry();
  const runHealthChecks = options.runHealthChecks ?? true;

  const planningLoad = await instantiatePlanningBackend(loadedConfig, registry);
  const contextLoad = await instantiateContextBackend(loadedConfig, registry);

  const planningCheck = createBootstrapCheck(planningLoad);
  const contextCheck = createBootstrapCheck(contextLoad);

  await validateBackend(planningLoad, planningCheck);
  await validateBackend(contextLoad, contextCheck);

  if (runHealthChecks) {
    await runBackendHealthCheck(planningLoad, planningCheck);
    await runBackendHealthCheck(contextLoad, contextCheck);
  }

  return {
    planning: planningLoad.backend,
    context: contextLoad.backend,
    report: {
      profileName: loadedConfig.activeProfileName,
      checks: [planningCheck, contextCheck],
    },
  };
}

type LoadedPlanningBackend = {
  backend: PlanningBackend;
  registration: RegisteredPlanningProvider;
};

type LoadedContextBackend = {
  backend: ContextBackend;
  registration: RegisteredContextProvider;
};

async function instantiatePlanningBackend(
  loadedConfig: LoadedConfig,
  registry: ProviderRegistry,
): Promise<LoadedPlanningBackend> {
  const profile = loadedConfig.activeProfile;
  const provider = profile.planningProvider as PlanningProviderConfig;
  const factoryInput: ProviderFactoryContext<PlanningProviderConfig> = {
    provider,
    profile,
    loadedConfig,
  };

  try {
    return await registry.createPlanningBackend(factoryInput);
  } catch (error) {
    if (error instanceof ProviderBootstrapError) {
      throw error;
    }

    throw new ProviderBootstrapError(
      `Failed to instantiate planning provider '${provider.name}'.`,
      {
        code: "provider_factory_failed",
        family: "planning",
        providerName: provider.name,
        providerKind: provider.kind,
        cause: error,
      },
    );
  }
}

async function instantiateContextBackend(
  loadedConfig: LoadedConfig,
  registry: ProviderRegistry,
): Promise<LoadedContextBackend> {
  const profile = loadedConfig.activeProfile;
  const provider = profile.contextProvider as ContextProviderConfig;
  const factoryInput: ProviderFactoryContext<ContextProviderConfig> = {
    provider,
    profile,
    loadedConfig,
  };

  try {
    return await registry.createContextBackend(factoryInput);
  } catch (error) {
    if (error instanceof ProviderBootstrapError) {
      throw error;
    }

    throw new ProviderBootstrapError(
      `Failed to instantiate context provider '${provider.name}'.`,
      {
        code: "provider_factory_failed",
        family: "context",
        providerName: provider.name,
        providerKind: provider.kind,
        cause: error,
      },
    );
  }
}

function createBootstrapCheck(
  loadedBackend: LoadedPlanningBackend | LoadedContextBackend,
): BootstrapCheck {
  return {
    family: loadedBackend.backend.family,
    providerName: loadedBackend.backend.name,
    providerKind: loadedBackend.backend.kind,
    source: loadedBackend.registration.source,
    validated: false,
    healthCheck: null,
  };
}

async function validateBackend(
  loadedBackend: LoadedPlanningBackend | LoadedContextBackend,
  check: BootstrapCheck,
): Promise<void> {
  try {
    await loadedBackend.backend.validateConfig();
    check.validated = true;
  } catch (error) {
    throw new ProviderBootstrapError(
      `${loadedBackend.backend.family} provider '${loadedBackend.backend.name}' failed validation.`,
      {
        code: "provider_validation_failed",
        family: loadedBackend.backend.family,
        providerName: loadedBackend.backend.name,
        providerKind: loadedBackend.backend.kind,
        source: loadedBackend.registration.source,
        cause: error,
      },
    );
  }
}

async function runBackendHealthCheck(
  loadedBackend: LoadedPlanningBackend | LoadedContextBackend,
  check: BootstrapCheck,
): Promise<void> {
  let result: ProviderHealthCheckResult;

  try {
    result = await loadedBackend.backend.healthCheck();
  } catch (error) {
    throw new ProviderBootstrapError(
      `${loadedBackend.backend.family} provider '${loadedBackend.backend.name}' health check threw an error.`,
      {
        code: "provider_healthcheck_failed",
        family: loadedBackend.backend.family,
        providerName: loadedBackend.backend.name,
        providerKind: loadedBackend.backend.kind,
        source: loadedBackend.registration.source,
        cause: error,
      },
    );
  }

  check.healthCheck = result;

  if (!result.ok) {
    throw new ProviderBootstrapError(
      `${loadedBackend.backend.family} provider '${loadedBackend.backend.name}' failed health check${result.message === undefined ? "." : `: ${result.message}`}`,
      {
        code: "provider_healthcheck_failed",
        family: loadedBackend.backend.family,
        providerName: loadedBackend.backend.name,
        providerKind: loadedBackend.backend.kind,
        source: loadedBackend.registration.source,
      },
    );
  }
}
