import { ProviderRegistry } from "../core/provider-registry.js";

import { LocalFilesContextBackend } from "./context/local-files-backend.js";
import { NotionContextBackend } from "./context/notion-backend.js";
import { LinearPlanningBackend } from "./planning/linear-backend.js";
import { LocalFilesPlanningBackend } from "./planning/local-files-backend.js";

export function registerBuiltinProviders(
  registry: ProviderRegistry = new ProviderRegistry(),
): ProviderRegistry {
  registry.registerPlanning(
    "planning.linear",
    ({ provider }) => new LinearPlanningBackend(provider),
    { source: "builtin" },
  );
  registry.registerPlanning(
    "planning.local_files",
    ({ provider }) => new LocalFilesPlanningBackend(provider),
    { source: "builtin" },
  );
  registry.registerContext(
    "context.notion",
    ({ provider }) => new NotionContextBackend(provider),
    { source: "builtin" },
  );
  registry.registerContext(
    "context.local_files",
    ({ provider }) => new LocalFilesContextBackend(provider),
    { source: "builtin" },
  );

  return registry;
}

export function createBuiltinProviderRegistry(): ProviderRegistry {
  return registerBuiltinProviders(new ProviderRegistry());
}
