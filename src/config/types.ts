export const BUILTIN_PROVIDER_KINDS = [
  "planning.linear",
  "planning.local_files",
  "context.notion",
  "context.local_files",
] as const;

export type ProviderKind = (typeof BUILTIN_PROVIDER_KINDS)[number];
export type PlanningProviderKind = Extract<ProviderKind, `planning.${string}`>;
export type ContextProviderKind = Extract<ProviderKind, `context.${string}`>;

export interface PathsConfig {
  stateDir: string;
  dataDir: string;
  logDir: string;
}

export interface PolicyConfig {
  maxConcurrentRuns: number;
  maxRunsPerProvider: number;
  allowMixedProviders: boolean;
  defaultPhaseTimeoutSec: number;
}

export interface PromptsConfig {
  root: string;
  activePack?: string;
}

export interface PromptPackConfig {
  name: string;
  baseSystem: string;
  roles: Record<string, string>;
  phases: Record<string, string>;
  capabilities: Record<string, string>;
  overlays: Record<string, string[]>;
  experiments: Record<string, string>;
}

interface BaseProviderConfig<K extends ProviderKind, F extends "planning" | "context"> {
  name: string;
  kind: K;
  family: F;
}

export interface PlanningLinearProviderConfig
  extends BaseProviderConfig<"planning.linear", "planning"> {
  tokenEnv: string;
  team: string;
  webhookSigningSecretEnv?: string;
  mapping: Record<string, string>;
}

export interface PlanningLocalFilesProviderConfig
  extends BaseProviderConfig<"planning.local_files", "planning"> {
  root: string;
}

export interface ContextNotionProviderConfig
  extends BaseProviderConfig<"context.notion", "context"> {
  tokenEnv: string;
  artifactsDatabaseId: string;
  runsDatabaseId: string;
}

export interface ContextLocalFilesProviderConfig
  extends BaseProviderConfig<"context.local_files", "context"> {
  root: string;
  templates: Record<string, string>;
}

export type PlanningProviderConfig =
  | PlanningLinearProviderConfig
  | PlanningLocalFilesProviderConfig;

export type ContextProviderConfig =
  | ContextNotionProviderConfig
  | ContextLocalFilesProviderConfig;

export type ProviderConfig = PlanningProviderConfig | ContextProviderConfig;

export interface ProfileConfig {
  name: string;
  planningProviderName: string;
  contextProviderName: string;
  promptPackName: string;
  planningProvider: PlanningProviderConfig;
  contextProvider: ContextProviderConfig;
  promptPack: PromptPackConfig;
}

export interface LoadedConfig {
  sourcePath: string;
  version: 1;
  paths: PathsConfig;
  policy: PolicyConfig;
  prompts: PromptsConfig;
  promptPacks: Record<string, PromptPackConfig>;
  providers: Record<string, ProviderConfig>;
  profiles: Record<string, ProfileConfig>;
  activeProfileName: string;
  activeProfile: ProfileConfig;
}

export interface LoadConfigOptions {
  configPath?: string;
  cwd?: string;
  activeProfile?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ParseConfigOptions {
  sourcePath: string;
  activeProfile?: string;
  env?: NodeJS.ProcessEnv;
}
