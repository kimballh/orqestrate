import type {
  ContextProviderConfig,
  ContextProviderKind,
  LoadedConfig,
  PlanningProviderConfig,
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
  TConfig extends PlanningProviderConfig | ContextProviderConfig,
> = {
  provider: TConfig;
  profile: ProfileConfig;
  loadedConfig: LoadedConfig;
};

export type PlanningBackendFactory<
  TConfig extends PlanningProviderConfig = PlanningProviderConfig,
> = (
  input: ProviderFactoryContext<TConfig>,
) => PlanningBackend<TConfig> | Promise<PlanningBackend<TConfig>>;

export type ContextBackendFactory<
  TConfig extends ContextProviderConfig = ContextProviderConfig,
> = (
  input: ProviderFactoryContext<TConfig>,
) => ContextBackend<TConfig> | Promise<ContextBackend<TConfig>>;

export type RegisteredPlanningProvider<
  TKind extends PlanningProviderKind = PlanningProviderKind,
> = {
  family: "planning";
  kind: TKind;
  source: ProviderRegistrationSource;
  create: PlanningBackendFactory<
    Extract<PlanningProviderConfig, { kind: TKind }>
  >;
};

export type RegisteredContextProvider<
  TKind extends ContextProviderKind = ContextProviderKind,
> = {
  family: "context";
  kind: TKind;
  source: ProviderRegistrationSource;
  create: ContextBackendFactory<Extract<ContextProviderConfig, { kind: TKind }>>;
};

type RegistrationOptions = {
  source?: ProviderRegistrationSource;
};

export class ProviderRegistry {
  private readonly planningFactories = new Map<
    PlanningProviderKind,
    RegisteredPlanningProvider
  >();
  private readonly contextFactories = new Map<
    ContextProviderKind,
    RegisteredContextProvider
  >();

  registerPlanning<TKind extends PlanningProviderKind>(
    kind: TKind,
    create: PlanningBackendFactory<
      Extract<PlanningProviderConfig, { kind: TKind }>
    >,
    options: RegistrationOptions = {},
  ): this {
    const registration: RegisteredPlanningProvider<TKind> = {
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
      registration as unknown as RegisteredPlanningProvider,
    );
    return this;
  }

  registerContext<TKind extends ContextProviderKind>(
    kind: TKind,
    create: ContextBackendFactory<Extract<ContextProviderConfig, { kind: TKind }>>,
    options: RegistrationOptions = {},
  ): this {
    const registration: RegisteredContextProvider<TKind> = {
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
      registration as unknown as RegisteredContextProvider,
    );
    return this;
  }

  getPlanningRegistration<TKind extends PlanningProviderKind>(
    kind: TKind,
  ): RegisteredPlanningProvider<TKind> {
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

    return registration as unknown as RegisteredPlanningProvider<TKind>;
  }

  getContextRegistration<TKind extends ContextProviderKind>(
    kind: TKind,
  ): RegisteredContextProvider<TKind> {
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

    return registration as unknown as RegisteredContextProvider<TKind>;
  }

  listPlanningRegistrations(): RegisteredPlanningProvider[] {
    return [...this.planningFactories.values()];
  }

  listContextRegistrations(): RegisteredContextProvider[] {
    return [...this.contextFactories.values()];
  }

  async createPlanningBackend<TKind extends PlanningProviderKind>(
    input: ProviderFactoryContext<Extract<PlanningProviderConfig, { kind: TKind }>>,
  ): Promise<{
    backend: PlanningBackend<Extract<PlanningProviderConfig, { kind: TKind }>>;
    registration: RegisteredPlanningProvider<TKind>;
  }> {
    const registration = this.getPlanningRegistration(input.provider.kind);

    return {
      backend: await registration.create(input),
      registration,
    };
  }

  async createContextBackend<TKind extends ContextProviderKind>(
    input: ProviderFactoryContext<Extract<ContextProviderConfig, { kind: TKind }>>,
  ): Promise<{
    backend: ContextBackend<Extract<ContextProviderConfig, { kind: TKind }>>;
    registration: RegisteredContextProvider<TKind>;
  }> {
    const registration = this.getContextRegistration(input.provider.kind);

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
