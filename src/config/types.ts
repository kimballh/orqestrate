import type { WorkPhase } from "../domain-model.js";

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

export const PROMPT_CAPABILITY_AUTHORITIES = [
  "behavioral",
  "execution_surface_read",
  "execution_surface_write",
] as const;

export type PromptCapabilityAuthority =
  (typeof PROMPT_CAPABILITY_AUTHORITIES)[number];

export const PROMPT_CAPABILITY_CONTEXT_REQUIREMENTS = [
  "pull_request_url",
  "assigned_branch",
  "write_scope",
  "artifact",
] as const;

export type PromptCapabilityContextRequirement =
  (typeof PROMPT_CAPABILITY_CONTEXT_REQUIREMENTS)[number];

export const PROMPT_CAPABILITY_PROVIDERS = ["github"] as const;

export type PromptCapabilityProvider =
  (typeof PROMPT_CAPABILITY_PROVIDERS)[number];

export const PROMPT_CAPABILITY_SURFACES = [
  "pull_request",
  "branch",
  "review_thread",
  "review_submission",
  "merge",
] as const;

export type PromptCapabilitySurface =
  (typeof PROMPT_CAPABILITY_SURFACES)[number];

export const PROMPT_CAPABILITY_EFFECTS = [
  "read",
  "write",
  "state_transition",
] as const;

export type PromptCapabilityEffect = (typeof PROMPT_CAPABILITY_EFFECTS)[number];

export const PROMPT_CAPABILITY_TARGET_SCOPES = [
  "linked_pull_request",
  "assigned_branch",
  "pull_request_for_assigned_branch",
] as const;

export type PromptCapabilityTargetScope =
  (typeof PROMPT_CAPABILITY_TARGET_SCOPES)[number];

export interface PromptCapabilityDefinition {
  authority: PromptCapabilityAuthority;
  allowedPhases: WorkPhase[];
  allowedRoles: WorkPhase[];
  requiredContext: PromptCapabilityContextRequirement[];
  requires: string[];
  conflictsWith: string[];
  provider?: PromptCapabilityProvider;
  surface?: PromptCapabilitySurface;
  effect?: PromptCapabilityEffect;
  targetScope?: PromptCapabilityTargetScope;
}

export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;

export type MergeMethod = (typeof MERGE_METHODS)[number];

export interface MergePolicyConfig {
  allowedMethods: MergeMethod[];
  requireHumanApproval: boolean;
}

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
  merge: MergePolicyConfig;
}

export interface PromptsConfig {
  root: string;
  activePack?: string;
  invariants: string[];
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
  promptCapabilities: Record<string, PromptCapabilityDefinition>;
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
