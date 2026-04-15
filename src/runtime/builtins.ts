import { RuntimeAdapterRegistry } from "./runtime-adapter-registry.js";
import { CodexProviderAdapter } from "./adapters/codex-adapter.js";

export function registerBuiltinRuntimeAdapters(
  registry: RuntimeAdapterRegistry = new RuntimeAdapterRegistry(),
): RuntimeAdapterRegistry {
  registry.register("codex", () => new CodexProviderAdapter());
  return registry;
}

export function createBuiltinRuntimeAdapterRegistry(): RuntimeAdapterRegistry {
  return registerBuiltinRuntimeAdapters(new RuntimeAdapterRegistry());
}
