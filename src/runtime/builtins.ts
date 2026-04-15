import { RuntimeAdapterRegistry } from "./runtime-adapter-registry.js";
import { ClaudeProviderAdapter } from "./adapters/claude-adapter.js";

export function registerBuiltinRuntimeAdapters(
  registry: RuntimeAdapterRegistry,
): RuntimeAdapterRegistry {
  registry.register("claude", () => new ClaudeProviderAdapter());
  return registry;
}

export function createBuiltinRuntimeAdapterRegistry(): RuntimeAdapterRegistry {
  return registerBuiltinRuntimeAdapters(new RuntimeAdapterRegistry());
}
