import path from "node:path";

import type { LoadedConfig } from "../config/types.js";

export type RuntimeConfig = {
  sourcePath: string;
  profileName: string;
  stateDir: string;
  logDir: string;
  runtimeLogDir: string;
  databasePath: string;
  policy: LoadedConfig["policy"];
};

export function resolveRuntimeConfig(loadedConfig: LoadedConfig): RuntimeConfig {
  return {
    sourcePath: loadedConfig.sourcePath,
    profileName: loadedConfig.activeProfileName,
    stateDir: loadedConfig.paths.stateDir,
    logDir: loadedConfig.paths.logDir,
    runtimeLogDir: path.join(loadedConfig.paths.logDir, "runtime"),
    databasePath: path.join(loadedConfig.paths.stateDir, "runtime.sqlite"),
    policy: { ...loadedConfig.policy },
  };
}
