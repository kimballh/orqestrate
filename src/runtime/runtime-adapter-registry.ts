import type { AgentProvider } from "../domain-model.js";
import { RuntimeError } from "./errors.js";
import type {
  ProviderAdapter,
  ProviderAdapterFactory,
} from "./provider-adapter.js";

export class RuntimeAdapterRegistry {
  private readonly factories = new Map<AgentProvider, ProviderAdapterFactory>();

  register(
    kind: AgentProvider,
    create: ProviderAdapterFactory,
  ): RuntimeAdapterRegistry {
    if (this.factories.has(kind)) {
      throw new RuntimeError(
        `Runtime provider adapter '${kind}' is already registered.`,
        {
          code: "duplicate_runtime_adapter",
        },
      );
    }

    this.factories.set(kind, create);
    return this;
  }

  create(kind: AgentProvider): ProviderAdapter {
    const factory = this.factories.get(kind);

    if (factory === undefined) {
      throw new RuntimeError(
        `No runtime provider adapter is registered for '${kind}'.`,
        {
          code: "runtime_adapter_not_found",
        },
      );
    }

    return factory();
  }

  listProviders(): AgentProvider[] {
    return [...this.factories.keys()].sort();
  }
}
