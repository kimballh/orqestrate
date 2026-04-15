import { RuntimeAdapterRegistry } from "./runtime-adapter-registry.js";
import { ClaudeProviderAdapter } from "./adapters/claude-adapter.js";
import { CodexProviderAdapter } from "./adapters/codex-adapter.js";

export function registerBuiltinRuntimeAdapters(
  registry: RuntimeAdapterRegistry = new RuntimeAdapterRegistry(),
): RuntimeAdapterRegistry {
  registry.register("codex", () => new CodexProviderAdapter());
  registry.register("claude", () => new ClaudeProviderAdapter());
  return registry;
}

export function createBuiltinRuntimeAdapterRegistry(): RuntimeAdapterRegistry {
  return registerBuiltinRuntimeAdapters(new RuntimeAdapterRegistry());
}
