import type {
  ContextProviderDefinition,
  ContextProviderKind,
  LoadedConfig,
  PlanningProviderDefinition,
  PlanningProviderKind,
  ProfileConfig,
} from "../config/types.js";

import type { ContextBackend } from "./context-backend.js";
import {
  ProviderBootstrapError,
  type ProviderRegistrationSource,
} from "./errors.js";
import type { PlanningBackend } from "./planning-backend.js";

export type ProviderFactoryContext<
  TConfig extends PlanningProviderDefinition | ContextProviderDefinition,
> = {
  provider: TConfig;
  profile: ProfileConfig;
  loadedConfig: LoadedConfig;
};

export type PlanningBackendFactory<
  TConfig extends PlanningProviderDefinition = PlanningProviderDefinition,
> = (
  input: ProviderFactoryContext<TConfig>,
) => PlanningBackend<TConfig> | Promise<PlanningBackend<TConfig>>;

export type ContextBackendFactory<
  TConfig extends ContextProviderDefinition = ContextProviderDefinition,
> = (
  input: ProviderFactoryContext<TConfig>,
) => ContextBackend<TConfig> | Promise<ContextBackend<TConfig>>;

export type RegisteredPlanningProvider<
  TConfig extends PlanningProviderDefinition = PlanningProviderDefinition,
> = {
  family: "planning";
  kind: TConfig["kind"];
  source: ProviderRegistrationSource;
  create: PlanningBackendFactory<TConfig>;
};

export type RegisteredContextProvider<
  TConfig extends ContextProviderDefinition = ContextProviderDefinition,
> = {
  family: "context";
  kind: TConfig["kind"];
  source: ProviderRegistrationSource;
  create: ContextBackendFactory<TConfig>;
};

type RegistrationOptions = {
  source?: ProviderRegistrationSource;
};

type AnyRegisteredPlanningProvider =
  RegisteredPlanningProvider<PlanningProviderDefinition>;
type AnyRegisteredContextProvider =
  RegisteredContextProvider<ContextProviderDefinition>;

export class ProviderRegistry {
  private readonly planningFactories = new Map<
    PlanningProviderKind,
    AnyRegisteredPlanningProvider
  >();
  private readonly contextFactories = new Map<
    ContextProviderKind,
    AnyRegisteredContextProvider
  >();

  registerPlanning<TConfig extends PlanningProviderDefinition>(
    kind: TConfig["kind"],
    create: PlanningBackendFactory<TConfig>,
    options: RegistrationOptions = {},
  ): this {
    const registration: RegisteredPlanningProvider<TConfig> = {
      family: "planning",
      kind,
      source: options.source ?? "extension",
      create,
    };

    this.assertNotRegistered(
      this.planningFactories,
      registration.family,
      registration.kind,
    );
    this.planningFactories.set(
      kind,
      registration as unknown as AnyRegisteredPlanningProvider,
    );
    return this;
  }

  registerContext<TConfig extends ContextProviderDefinition>(
    kind: TConfig["kind"],
    create: ContextBackendFactory<TConfig>,
    options: RegistrationOptions = {},
  ): this {
    const registration: RegisteredContextProvider<TConfig> = {
      family: "context",
      kind,
      source: options.source ?? "extension",
      create,
    };

    this.assertNotRegistered(
      this.contextFactories,
      registration.family,
      registration.kind,
    );
    this.contextFactories.set(
      kind,
      registration as unknown as AnyRegisteredContextProvider,
    );
    return this;
  }

  getPlanningRegistration<TKind extends PlanningProviderKind>(
    kind: TKind,
  ): RegisteredPlanningProvider<PlanningProviderDefinition<TKind>> {
    const registration = this.planningFactories.get(kind);

    if (registration === undefined) {
      throw new ProviderBootstrapError(
        `No planning provider factory is registered for '${kind}'.`,
        {
          code: "unknown_provider_factory",
          family: "planning",
          providerKind: kind,
        },
      );
    }

    return registration as unknown as RegisteredPlanningProvider<
      PlanningProviderDefinition<TKind>
    >;
  }

  getContextRegistration<TKind extends ContextProviderKind>(
    kind: TKind,
  ): RegisteredContextProvider<ContextProviderDefinition<TKind>> {
    const registration = this.contextFactories.get(kind);

    if (registration === undefined) {
      throw new ProviderBootstrapError(
        `No context provider factory is registered for '${kind}'.`,
        {
          code: "unknown_provider_factory",
          family: "context",
          providerKind: kind,
        },
      );
    }

    return registration as unknown as RegisteredContextProvider<
      ContextProviderDefinition<TKind>
    >;
  }

  listPlanningRegistrations(): RegisteredPlanningProvider[] {
    return [...this.planningFactories.values()];
  }

  listContextRegistrations(): RegisteredContextProvider[] {
    return [...this.contextFactories.values()];
  }

  async createPlanningBackend<TConfig extends PlanningProviderDefinition>(
    input: ProviderFactoryContext<TConfig>,
  ): Promise<{
    backend: PlanningBackend<TConfig>;
    registration: RegisteredPlanningProvider<TConfig>;
  }> {
    const registration = this.getPlanningRegistration(
      input.provider.kind,
    ) as unknown as RegisteredPlanningProvider<TConfig>;

    return {
      backend: await registration.create(input),
      registration,
    };
  }

  async createContextBackend<TConfig extends ContextProviderDefinition>(
    input: ProviderFactoryContext<TConfig>,
  ): Promise<{
    backend: ContextBackend<TConfig>;
    registration: RegisteredContextProvider<TConfig>;
  }> {
    const registration = this.getContextRegistration(
      input.provider.kind,
    ) as unknown as RegisteredContextProvider<TConfig>;

    return {
      backend: await registration.create(input),
      registration,
    };
  }

  private assertNotRegistered(
    registry: Map<string, { kind: string }>,
    family: "planning" | "context",
    kind: string,
  ): void {
    if (registry.has(kind)) {
      throw new ProviderBootstrapError(
        `${family} provider kind '${kind}' is already registered.`,
        {
          code: "duplicate_provider_registration",
          family,
          providerKind: kind,
        },
      );
    }
  }
}
