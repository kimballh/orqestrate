export const BUILTIN_PROVIDER_KINDS = [
  "planning.linear",
  "planning.local_files",
  "context.notion",
  "context.local_files",
] as const;

export const LINEAR_STATUS_MAPPING_KEYS = [
  "backlog_status",
  "design_status",
  "plan_status",
  "implement_status",
  "review_status",
  "blocked_status",
  "done_status",
  "canceled_status",
] as const;

export type ProviderKind = `${"planning" | "context"}.${string}`;
export type PlanningProviderKind = `planning.${string}`;
export type ContextProviderKind = `context.${string}`;
export type BuiltinProviderKind = (typeof BUILTIN_PROVIDER_KINDS)[number];
export type BuiltinPlanningProviderKind = Extract<
  BuiltinProviderKind,
  PlanningProviderKind
>;
export type BuiltinContextProviderKind = Extract<
  BuiltinProviderKind,
  ContextProviderKind
>;
export type LinearStatusMappingKey = (typeof LINEAR_STATUS_MAPPING_KEYS)[number];

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

export const PROMPT_OVERLAY_GROUPS = ["organization", "project"] as const;

export type PromptOverlayGroup = (typeof PROMPT_OVERLAY_GROUPS)[number];

export interface NamedPromptAsset {
  name: string;
  assetPath: string;
}

export type PromptOverlayCatalog = Record<PromptOverlayGroup, Record<string, string>>;

export interface PromptPackConfig {
  name: string;
  baseSystem: string;
  roles: Record<string, string>;
  phases: Record<string, string>;
  capabilities: Record<string, string>;
  overlays: PromptOverlayCatalog;
  experiments: Record<string, string>;
}

export interface ResolvedPromptBehavior {
  promptPackName: string;
  promptPack: PromptPackConfig;
  organizationOverlayNames: string[];
  projectOverlayNames: string[];
  organizationOverlays: NamedPromptAsset[];
  projectOverlays: NamedPromptAsset[];
  defaultExperimentName?: string;
  defaultExperimentAssetPath?: string;
}

export interface BaseProviderConfig<
  K extends ProviderKind,
  F extends "planning" | "context",
> {
  name: string;
  kind: K;
  family: F;
}

export type PlanningProviderDefinition<
  K extends PlanningProviderKind = PlanningProviderKind,
> = BaseProviderConfig<K, "planning">;

export type ContextProviderDefinition<
  K extends ContextProviderKind = ContextProviderKind,
> = BaseProviderConfig<K, "context">;

export type ProviderDefinition =
  | PlanningProviderDefinition
  | ContextProviderDefinition;

export interface PlanningLinearProviderConfig
  extends BaseProviderConfig<"planning.linear", "planning"> {
  tokenEnv: string;
  team: string;
  project?: string;
  webhookSigningSecretEnv?: string;
  mapping: Partial<Record<LinearStatusMappingKey, string>>;
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
  promptBehavior: ResolvedPromptBehavior;
}

export interface LoadedConfig {
  sourcePath: string;
  version: 1;
  env: NodeJS.ProcessEnv;
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
