import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

import { ConfigError } from "./errors.js";
import {
  PromptSelectionError,
  resolveProfilePromptBehavior,
} from "./prompt-selection.js";
import {
  type BuiltinProviderKind,
  BUILTIN_PROVIDER_KINDS,
  type ContextLocalFilesProviderConfig,
  type ContextNotionProviderConfig,
  type ContextProviderConfig,
  type LoadConfigOptions,
  type LoadedConfig,
  MERGE_METHODS,
  type MergeMethod,
  type ParseConfigOptions,
  type PathsConfig,
  type PlanningLinearProviderConfig,
  type PlanningLocalFilesProviderConfig,
  type PlanningProviderConfig,
  type PolicyConfig,
  type ProfileConfig,
  type WorkspaceConfig,
  PROMPT_CAPABILITY_AUTHORITIES,
  PROMPT_CAPABILITY_CONTEXT_REQUIREMENTS,
  PROMPT_CAPABILITY_EFFECTS,
  PROMPT_CAPABILITY_PROVIDERS,
  PROMPT_CAPABILITY_SURFACES,
  PROMPT_CAPABILITY_TARGET_SCOPES,
  PROMPT_OVERLAY_GROUPS,
  type PromptCapabilityAuthority,
  type PromptCapabilityEffect,
  type PromptCapabilityContextRequirement,
  type PromptCapabilityDefinition,
  type PromptCapabilityProvider,
  type PromptCapabilitySurface,
  type PromptCapabilityTargetScope,
  type PromptPackConfig,
  type PromptsConfig,
  type ProviderConfig,
} from "./types.js";
import { WORK_PHASES, type WorkPhase } from "../domain-model.js";

type ValueRecord = Record<string, unknown>;

const TOP_LEVEL_KEYS = [
  "version",
  "active_profile",
  "paths",
  "workspace",
  "policy",
  "prompts",
  "prompt_capabilities",
  "prompt_packs",
  "providers",
  "profiles",
] as const;

const PROVIDER_KIND_SET = new Set<string>(BUILTIN_PROVIDER_KINDS);
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WORK_PHASE_SET = new Set<string>(WORK_PHASES);
const PROMPT_CAPABILITY_AUTHORITY_SET = new Set<string>(
  PROMPT_CAPABILITY_AUTHORITIES,
);
const PROMPT_CAPABILITY_CONTEXT_REQUIREMENT_SET = new Set<string>(
  PROMPT_CAPABILITY_CONTEXT_REQUIREMENTS,
);
const PROMPT_CAPABILITY_PROVIDER_SET = new Set<string>(
  PROMPT_CAPABILITY_PROVIDERS,
);
const PROMPT_CAPABILITY_SURFACE_SET = new Set<string>(
  PROMPT_CAPABILITY_SURFACES,
);
const PROMPT_CAPABILITY_EFFECT_SET = new Set<string>(
  PROMPT_CAPABILITY_EFFECTS,
);
const PROMPT_CAPABILITY_TARGET_SCOPE_SET = new Set<string>(
  PROMPT_CAPABILITY_TARGET_SCOPES,
);

const POLICY_DEFAULTS: PolicyConfig = {
  maxConcurrentRuns: 4,
  maxRunsPerProvider: 2,
  allowMixedProviders: true,
  defaultPhaseTimeoutSec: 5400,
  merge: {
    allowedMethods: ["squash"],
    requireHumanApproval: false,
  },
};

export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const sourcePath =
    options.configPath === undefined
      ? path.resolve(cwd, "config.toml")
      : path.resolve(cwd, options.configPath);

  let source: string;

  try {
    source = await readFile(sourcePath, "utf8");
  } catch (error) {
    if (isErrnoError(error, "ENOENT")) {
      throw new ConfigError(`Config file not found at '${sourcePath}'.`, {
        code: "config_not_found",
        path: "sourcePath",
        hint: "Create config.toml or pass an explicit configPath.",
        cause: error,
      });
    }

    throw new ConfigError(`Failed to read config file '${sourcePath}'.`, {
      code: "config_read_error",
      path: "sourcePath",
      cause: error,
    });
  }

  return parseConfig(source, {
    sourcePath,
    activeProfile: options.activeProfile,
    env: options.env,
  });
}

export function parseConfig(
  source: string,
  options: ParseConfigOptions,
): LoadedConfig {
  const sourcePath = path.resolve(options.sourcePath);
  const configDir = path.dirname(sourcePath);
  const env = options.env ?? process.env;

  let parsedDocument: unknown;

  try {
    parsedDocument = parseToml(source);
  } catch (error) {
    throw new ConfigError(`Failed to parse TOML in '${sourcePath}'.`, {
      code: "config_parse_error",
      path: "sourcePath",
      hint: error instanceof Error ? error.message : undefined,
      cause: error,
    });
  }

  const document = expectRecord(parsedDocument, "config");
  assertAllowedKeys(document, TOP_LEVEL_KEYS, "");

  const version = parseVersion(document.version);
  const configuredActiveProfile = readOptionalString(
    document,
    "active_profile",
    "",
  );
  const paths = parsePathsSection(document.paths, configDir);
  const workspace = parseWorkspaceSection(document.workspace, configDir);
  const policy = parsePolicySection(document.policy);
  const prompts = parsePromptsSection(document.prompts, configDir);
  const promptCapabilities = parsePromptCapabilitiesSection(
    document.prompt_capabilities,
  );
  const promptPacks = parsePromptPacksSection(document.prompt_packs, prompts.root);
  validatePromptCapabilityRegistry(promptCapabilities);
  validatePromptPackCapabilityReferences(promptPacks, promptCapabilities);

  if (
    prompts.activePack !== undefined &&
    !hasOwn(promptPacks, prompts.activePack)
  ) {
    throw new ConfigError(
      `Prompt pack '${prompts.activePack}' does not exist.`,
      {
        code: "invalid_value",
        path: "prompts.active_pack",
        hint: `Defined prompt packs: ${Object.keys(promptPacks).join(", ")}`,
      },
    );
  }

  const providers = parseProvidersSection(document.providers, configDir);
  const profiles = parseProfilesSection(
    document.profiles,
    providers,
    promptPacks,
    prompts.activePack,
  );

  if (
    configuredActiveProfile !== undefined &&
    !hasOwn(profiles, configuredActiveProfile)
  ) {
    throw new ConfigError(
      `Active profile '${configuredActiveProfile}' does not exist.`,
      {
        code: "invalid_value",
        path: "active_profile",
        hint: `Defined profiles: ${Object.keys(profiles).join(", ")}`,
      },
    );
  }

  const activeProfileName = resolveActiveProfileName(
    options.activeProfile,
    configuredActiveProfile,
    profiles,
  );
  const activeProfile = profiles[activeProfileName];

  validateSelectedProfileEnvRefs(activeProfile, env);

  return {
    sourcePath,
    version,
    env,
    paths,
    workspace,
    policy,
    prompts,
    promptCapabilities,
    promptPacks,
    providers,
    profiles,
    activeProfileName,
    activeProfile,
  };
}

function parseVersion(value: unknown): 1 {
  const version = expectInteger(value, "version", { min: 1 });

  if (version !== 1) {
    throw new ConfigError(`Unsupported config version '${version}'.`, {
      code: "unsupported_version",
      path: "version",
      hint: "Only version = 1 is supported right now.",
    });
  }

  return 1;
}

function parsePathsSection(value: unknown, configDir: string): PathsConfig {
  const section = expectRequiredRecord(value, "paths");
  assertAllowedKeys(section, ["state_dir", "data_dir", "log_dir"], "paths");

  return {
    stateDir: resolveFileSystemPath(
      expectNonEmptyString(section.state_dir, "paths.state_dir"),
      configDir,
      "paths.state_dir",
    ),
    dataDir: resolveFileSystemPath(
      expectNonEmptyString(section.data_dir, "paths.data_dir"),
      configDir,
      "paths.data_dir",
    ),
    logDir: resolveFileSystemPath(
      expectNonEmptyString(section.log_dir, "paths.log_dir"),
      configDir,
      "paths.log_dir",
    ),
  };
}

function parseWorkspaceSection(
  value: unknown,
  configDir: string,
): WorkspaceConfig {
  if (value === undefined) {
    return {};
  }

  const section = expectRecord(value, "workspace");
  assertAllowedKeys(section, ["setup_script"], "workspace");

  return {
    setupScript:
      section.setup_script === undefined
        ? undefined
        : resolveFileSystemPath(
            expectNonEmptyString(section.setup_script, "workspace.setup_script"),
            configDir,
            "workspace.setup_script",
          ),
  };
}

function parsePolicySection(value: unknown): PolicyConfig {
  if (value === undefined) {
    return { ...POLICY_DEFAULTS };
  }

  const section = expectRecord(value, "policy");
  assertAllowedKeys(
    section,
    [
      "max_concurrent_runs",
      "max_runs_per_provider",
      "allow_mixed_providers",
      "default_phase_timeout_sec",
      "merge",
    ],
    "policy",
  );

  return {
    maxConcurrentRuns:
      section.max_concurrent_runs === undefined
        ? POLICY_DEFAULTS.maxConcurrentRuns
        : expectInteger(section.max_concurrent_runs, "policy.max_concurrent_runs", {
            min: 1,
          }),
    maxRunsPerProvider:
      section.max_runs_per_provider === undefined
        ? POLICY_DEFAULTS.maxRunsPerProvider
        : expectInteger(
            section.max_runs_per_provider,
            "policy.max_runs_per_provider",
            { min: 1 },
          ),
    allowMixedProviders:
      section.allow_mixed_providers === undefined
        ? POLICY_DEFAULTS.allowMixedProviders
        : expectBoolean(
            section.allow_mixed_providers,
            "policy.allow_mixed_providers",
          ),
    defaultPhaseTimeoutSec:
      section.default_phase_timeout_sec === undefined
        ? POLICY_DEFAULTS.defaultPhaseTimeoutSec
        : expectInteger(
            section.default_phase_timeout_sec,
            "policy.default_phase_timeout_sec",
            { min: 1 },
          ),
    merge: parseMergePolicySection(section.merge),
  };
}

function parseMergePolicySection(value: unknown): PolicyConfig["merge"] {
  if (value === undefined) {
    return {
      allowedMethods: [...POLICY_DEFAULTS.merge.allowedMethods],
      requireHumanApproval: POLICY_DEFAULTS.merge.requireHumanApproval,
    };
  }

  const section = expectRecord(value, "policy.merge");
  assertAllowedKeys(
    section,
    ["allowed_methods", "require_human_approval"],
    "policy.merge",
  );

  return {
    allowedMethods:
      section.allowed_methods === undefined
        ? [...POLICY_DEFAULTS.merge.allowedMethods]
        : parseMergeMethodArray(
            section.allowed_methods,
            "policy.merge.allowed_methods",
          ),
    requireHumanApproval:
      section.require_human_approval === undefined
        ? POLICY_DEFAULTS.merge.requireHumanApproval
        : expectBoolean(
            section.require_human_approval,
            "policy.merge.require_human_approval",
          ),
  };
}

function parsePromptsSection(value: unknown, configDir: string): PromptsConfig {
  const section = expectRequiredRecord(value, "prompts");
  assertAllowedKeys(section, ["root", "active_pack", "invariants"], "prompts");

  const activePack =
    section.active_pack === undefined
      ? undefined
      : expectNonEmptyString(section.active_pack, "prompts.active_pack");
  const root = resolveFileSystemPath(
    expectNonEmptyString(section.root, "prompts.root"),
    configDir,
    "prompts.root",
  );
  const invariants = expectStringArray(
    section.invariants,
    "prompts.invariants",
  ).map((entry, index) => {
    const fieldPath = `prompts.invariants[${index}]`;
    const resolvedPath = resolvePromptAssetPath(entry, fieldPath, root);
    assertPromptAssetHasContent(resolvedPath, fieldPath);
    return resolvedPath;
  });

  if (invariants.length === 0) {
    throw new ConfigError("Expected 'prompts.invariants' to contain at least one prompt asset.", {
      code: "invalid_value",
      path: "prompts.invariants",
      hint: "Configure the required hard-invariant prompt fragments explicitly.",
    });
  }

  return {
    root,
    activePack,
    invariants,
  };
}

function parsePromptCapabilitiesSection(
  value: unknown,
): Record<string, PromptCapabilityDefinition> {
  if (value === undefined) {
    return {};
  }

  const section = expectRecord(value, "prompt_capabilities");

  return Object.fromEntries(
    Object.entries(section).map(([name, definitionValue]) => {
      const definitionPath = joinPath("prompt_capabilities", name);
      const definition = expectRecord(definitionValue, definitionPath);

      assertAllowedKeys(
        definition,
        [
          "authority",
          "allowed_phases",
          "allowed_roles",
          "required_context",
          "requires",
          "conflicts_with",
          "provider",
          "surface",
          "effect",
          "target_scope",
        ],
        definitionPath,
      );

      return [
        name,
        {
          authority: parsePromptCapabilityAuthority(
            definition.authority,
            `${definitionPath}.authority`,
          ),
          allowedPhases: parseWorkPhaseArray(
            definition.allowed_phases,
            `${definitionPath}.allowed_phases`,
          ),
          allowedRoles: parseWorkPhaseArray(
            definition.allowed_roles,
            `${definitionPath}.allowed_roles`,
          ),
          requiredContext: parsePromptCapabilityContextRequirementArray(
            definition.required_context,
            `${definitionPath}.required_context`,
          ),
          requires:
            definition.requires === undefined
              ? []
              : expectStringArray(definition.requires, `${definitionPath}.requires`),
          conflictsWith:
            definition.conflicts_with === undefined
              ? []
              : expectStringArray(
                  definition.conflicts_with,
                  `${definitionPath}.conflicts_with`,
                ),
          provider:
            definition.provider === undefined
              ? undefined
              : parsePromptCapabilityProvider(
                  definition.provider,
                  `${definitionPath}.provider`,
                ),
          surface:
            definition.surface === undefined
              ? undefined
              : parsePromptCapabilitySurface(
                  definition.surface,
                  `${definitionPath}.surface`,
                ),
          effect:
            definition.effect === undefined
              ? undefined
              : parsePromptCapabilityEffect(
                  definition.effect,
                  `${definitionPath}.effect`,
                ),
          targetScope:
            definition.target_scope === undefined
              ? undefined
              : parsePromptCapabilityTargetScope(
                  definition.target_scope,
                  `${definitionPath}.target_scope`,
                ),
        } satisfies PromptCapabilityDefinition,
      ];
    }),
  );
}

function parsePromptPacksSection(
  value: unknown,
  promptRoot: string,
): Record<string, PromptPackConfig> {
  const section = expectRequiredRecord(value, "prompt_packs");
  assertNonEmptyNamedSection(section, "prompt_packs");

  return Object.fromEntries(
    Object.entries(section).map(([name, packValue]) => {
      const packPath = joinPath("prompt_packs", name);
      const pack = expectRecord(packValue, packPath);

      assertAllowedKeys(
        pack,
        ["base_system", "roles", "phases", "capabilities", "overlays", "experiments"],
        packPath,
      );

      return [
        name,
        {
          name,
          baseSystem: resolvePromptAssetPath(
            expectNonEmptyString(pack.base_system, `${packPath}.base_system`),
            `${packPath}.base_system`,
            promptRoot,
          ),
          roles: parsePromptAssetMap(pack.roles, `${packPath}.roles`, promptRoot),
          phases: parsePromptAssetMap(pack.phases, `${packPath}.phases`, promptRoot),
          capabilities: parsePromptAssetMap(
            pack.capabilities,
            `${packPath}.capabilities`,
            promptRoot,
          ),
          overlays: parsePromptOverlayCatalog(
            pack.overlays,
            `${packPath}.overlays`,
            promptRoot,
          ),
          experiments: parsePromptAssetMap(
            pack.experiments,
            `${packPath}.experiments`,
            promptRoot,
          ),
        } satisfies PromptPackConfig,
      ];
    }),
  );
}

function parseProvidersSection(
  value: unknown,
  configDir: string,
): Record<string, ProviderConfig> {
  const section = expectRequiredRecord(value, "providers");
  assertNonEmptyNamedSection(section, "providers");

  return Object.fromEntries(
    Object.entries(section).map(([name, providerValue]) => [
      name,
      parseProvider(name, providerValue, configDir),
    ]),
  );
}

function parseProvider(
  name: string,
  value: unknown,
  configDir: string,
): ProviderConfig {
  const providerPath = joinPath("providers", name);
  const provider = expectRecord(value, providerPath);
  const kind = expectNonEmptyString(provider.kind, `${providerPath}.kind`);

  if (!PROVIDER_KIND_SET.has(kind)) {
    throw new ConfigError(`Unsupported provider kind '${kind}'.`, {
      code: "unsupported_provider_kind",
      path: `${providerPath}.kind`,
      hint: `Supported kinds: ${BUILTIN_PROVIDER_KINDS.join(", ")}`,
    });
  }

  switch (kind as BuiltinProviderKind) {
    case "planning.linear":
      return parsePlanningLinearProvider(name, provider, providerPath);
    case "planning.local_files":
      return parsePlanningLocalFilesProvider(name, provider, providerPath, configDir);
    case "context.notion":
      return parseContextNotionProvider(name, provider, providerPath);
    case "context.local_files":
      return parseContextLocalFilesProvider(name, provider, providerPath, configDir);
  }
}

function parsePlanningLinearProvider(
  name: string,
  provider: ValueRecord,
  providerPath: string,
): PlanningLinearProviderConfig {
  assertAllowedKeys(
    provider,
    [
      "kind",
      "token_env",
      "team",
      "project",
      "webhook_signing_secret_env",
      "mapping",
    ],
    providerPath,
  );

  return {
    name,
    family: "planning",
    kind: "planning.linear",
    tokenEnv: parseEnvVarReference(provider.token_env, `${providerPath}.token_env`),
    team: expectNonEmptyString(provider.team, `${providerPath}.team`),
    project:
      provider.project === undefined
        ? undefined
        : expectNonEmptyString(provider.project, `${providerPath}.project`),
    webhookSigningSecretEnv:
      provider.webhook_signing_secret_env === undefined
        ? undefined
        : parseEnvVarReference(
            provider.webhook_signing_secret_env,
            `${providerPath}.webhook_signing_secret_env`,
          ),
    mapping: parseStringMap(provider.mapping, `${providerPath}.mapping`),
  };
}

function parsePlanningLocalFilesProvider(
  name: string,
  provider: ValueRecord,
  providerPath: string,
  configDir: string,
): PlanningLocalFilesProviderConfig {
  assertAllowedKeys(provider, ["kind", "root"], providerPath);

  return {
    name,
    family: "planning",
    kind: "planning.local_files",
    root: resolveFileSystemPath(
      expectNonEmptyString(provider.root, `${providerPath}.root`),
      configDir,
      `${providerPath}.root`,
    ),
  };
}

function parseContextNotionProvider(
  name: string,
  provider: ValueRecord,
  providerPath: string,
): ContextNotionProviderConfig {
  assertAllowedKeys(
    provider,
    ["kind", "token_env", "artifacts_database_id", "runs_database_id"],
    providerPath,
  );

  return {
    name,
    family: "context",
    kind: "context.notion",
    tokenEnv: parseEnvVarReference(provider.token_env, `${providerPath}.token_env`),
    artifactsDatabaseId: expectNonEmptyString(
      provider.artifacts_database_id,
      `${providerPath}.artifacts_database_id`,
    ),
    runsDatabaseId: expectNonEmptyString(
      provider.runs_database_id,
      `${providerPath}.runs_database_id`,
    ),
  };
}

function parseContextLocalFilesProvider(
  name: string,
  provider: ValueRecord,
  providerPath: string,
  configDir: string,
): ContextLocalFilesProviderConfig {
  assertAllowedKeys(provider, ["kind", "root", "templates"], providerPath);

  return {
    name,
    family: "context",
    kind: "context.local_files",
    root: resolveFileSystemPath(
      expectNonEmptyString(provider.root, `${providerPath}.root`),
      configDir,
      `${providerPath}.root`,
    ),
    templates: Object.fromEntries(
      Object.entries(parseStringMap(provider.templates, `${providerPath}.templates`)).map(
        ([templateName, templatePath]) => [
          templateName,
          resolveFileSystemPath(
            templatePath,
            configDir,
            `${providerPath}.templates.${templateName}`,
          ),
        ],
      ),
    ),
  };
}

function parseProfilesSection(
  value: unknown,
  providers: Record<string, ProviderConfig>,
  promptPacks: Record<string, PromptPackConfig>,
  defaultPromptPack: string | undefined,
): Record<string, ProfileConfig> {
  const section = expectRequiredRecord(value, "profiles");
  assertNonEmptyNamedSection(section, "profiles");

  return Object.fromEntries(
    Object.entries(section).map(([name, profileValue]) => {
      const profilePath = joinPath("profiles", name);
      const profile = expectRecord(profileValue, profilePath);

      assertAllowedKeys(
        profile,
        ["planning", "context", "prompt_pack", "prompt"],
        profilePath,
      );

      const planningProviderName = expectNonEmptyString(
        profile.planning,
        `${profilePath}.planning`,
      );
      const planningProvider = providers[planningProviderName];

      if (planningProvider === undefined) {
        throw new ConfigError(
          `Profile '${name}' references unknown planning provider '${planningProviderName}'.`,
          {
            code: "unknown_provider_reference",
            path: `${profilePath}.planning`,
            hint: `Defined providers: ${Object.keys(providers).join(", ")}`,
          },
        );
      }

      if (planningProvider.family !== "planning") {
        throw new ConfigError(
          `Profile '${name}' planning provider '${planningProviderName}' must be a planning backend, but is '${planningProvider.kind}'.`,
          {
            code: "provider_role_mismatch",
            path: `${profilePath}.planning`,
          },
        );
      }

      const contextProviderName = expectNonEmptyString(
        profile.context,
        `${profilePath}.context`,
      );
      const contextProvider = providers[contextProviderName];

      if (contextProvider === undefined) {
        throw new ConfigError(
          `Profile '${name}' references unknown context provider '${contextProviderName}'.`,
          {
            code: "unknown_provider_reference",
            path: `${profilePath}.context`,
            hint: `Defined providers: ${Object.keys(providers).join(", ")}`,
          },
        );
      }

      if (contextProvider.family !== "context") {
        throw new ConfigError(
          `Profile '${name}' context provider '${contextProviderName}' must be a context backend, but is '${contextProvider.kind}'.`,
          {
            code: "provider_role_mismatch",
            path: `${profilePath}.context`,
          },
        );
      }

      const promptPackName =
        profile.prompt_pack === undefined
          ? defaultPromptPack
          : expectNonEmptyString(profile.prompt_pack, `${profilePath}.prompt_pack`);

      if (promptPackName === undefined) {
        throw new ConfigError(
          `Profile '${name}' does not select a prompt pack.`,
          {
            code: "missing_field",
            path: `${profilePath}.prompt_pack`,
            hint: "Set profiles.<name>.prompt_pack or prompts.active_pack.",
          },
        );
      }

      const promptPack = promptPacks[promptPackName];

      if (promptPack === undefined) {
        throw new ConfigError(
          `Profile '${name}' references unknown prompt pack '${promptPackName}'.`,
          {
            code: "invalid_value",
            path:
              profile.prompt_pack === undefined
                ? "prompts.active_pack"
                : `${profilePath}.prompt_pack`,
            hint: `Defined prompt packs: ${Object.keys(promptPacks).join(", ")}`,
          },
        );
      }

      const promptSelection = parseProfilePromptSelection(profile.prompt, profilePath);

      let promptBehavior: ProfileConfig["promptBehavior"];

      try {
        promptBehavior = resolveProfilePromptBehavior(
          { name },
          promptPackName,
          promptPack,
          promptSelection,
        );
      } catch (error) {
        if (error instanceof PromptSelectionError) {
          const fieldPath = `${profilePath}.prompt.${error.field}`;
          throw new ConfigError(error.message, {
            code: "invalid_value",
            path: fieldPath,
            hint: buildPromptSelectionHint(promptPack, fieldPath),
            cause: error,
          });
        }

        if (error instanceof Error) {
          throw new ConfigError(error.message, {
            code: "invalid_value",
            path: `${profilePath}.prompt`,
            cause: error,
          });
        }

        throw error;
      }

      return [
        name,
        {
          name,
          planningProviderName,
          contextProviderName,
          promptPackName,
          planningProvider,
          contextProvider,
          promptPack,
          promptBehavior,
        } satisfies ProfileConfig,
      ];
    }),
  );
}

function resolveActiveProfileName(
  override: string | undefined,
  configuredActiveProfile: string | undefined,
  profiles: Record<string, ProfileConfig>,
): string {
  if (override !== undefined) {
    if (!hasOwn(profiles, override)) {
      throw new ConfigError(`Active profile override '${override}' does not exist.`, {
        code: "invalid_value",
        path: "activeProfile",
        hint: `Defined profiles: ${Object.keys(profiles).join(", ")}`,
      });
    }

    return override;
  }

  if (configuredActiveProfile !== undefined) {
    return configuredActiveProfile;
  }

  throw new ConfigError("No active profile was selected.", {
    code: "missing_active_profile",
    path: "active_profile",
    hint: "Set active_profile in config.toml or pass an activeProfile override.",
  });
}

function validateSelectedProfileEnvRefs(
  profile: ProfileConfig,
  env: NodeJS.ProcessEnv,
): void {
  for (const ref of getProviderEnvRefs(profile.planningProvider)) {
    assertEnvVarPresent(ref.envName, ref.path, profile.name, env);
  }

  for (const ref of getProviderEnvRefs(profile.contextProvider)) {
    assertEnvVarPresent(ref.envName, ref.path, profile.name, env);
  }
}

function getProviderEnvRefs(
  provider: PlanningProviderConfig | ContextProviderConfig,
): Array<{ envName: string; path: string }> {
  switch (provider.kind) {
    case "planning.linear":
      return [
        { envName: provider.tokenEnv, path: `providers.${provider.name}.token_env` },
        ...(provider.webhookSigningSecretEnv === undefined
          ? []
          : [
              {
                envName: provider.webhookSigningSecretEnv,
                path: `providers.${provider.name}.webhook_signing_secret_env`,
              },
            ]),
      ];
    case "context.notion":
      return [
        { envName: provider.tokenEnv, path: `providers.${provider.name}.token_env` },
      ];
    case "planning.local_files":
    case "context.local_files":
      return [];
  }
}

function assertEnvVarPresent(
  envName: string,
  fieldPath: string,
  profileName: string,
  env: NodeJS.ProcessEnv,
): void {
  const value = env[envName];

  if (value === undefined || value.trim() === "") {
    throw new ConfigError(
      `Env var '${envName}' is not set for active profile '${profileName}'.`,
      {
        code: "missing_env_var",
        path: fieldPath,
        hint: `Set ${envName} before loading profile '${profileName}'.`,
      },
    );
  }
}

function parseEnvVarReference(value: unknown, fieldPath: string): string {
  const envName = expectNonEmptyString(value, fieldPath);

  if (!ENV_VAR_NAME_PATTERN.test(envName)) {
    throw new ConfigError(`Invalid env var reference '${envName}'.`, {
      code: "invalid_value",
      path: fieldPath,
      hint: "Use shell-style env var names such as LINEAR_API_KEY.",
    });
  }

  return envName;
}

function parsePromptAssetMap(
  value: unknown,
  fieldPath: string,
  promptRoot: string,
): Record<string, string> {
  if (value === undefined) {
    return {};
  }

  const record = expectRecord(value, fieldPath);

  return Object.fromEntries(
    Object.entries(record).map(([name, entryValue]) => [
      name,
      resolvePromptAssetPath(
        expectNonEmptyString(entryValue, joinPath(fieldPath, name)),
        joinPath(fieldPath, name),
        promptRoot,
      ),
    ]),
  );
}

function parsePromptOverlayCatalog(
  value: unknown,
  fieldPath: string,
  promptRoot: string,
) {
  const catalog = Object.fromEntries(
    PROMPT_OVERLAY_GROUPS.map((group) => [group, {}] as const),
  ) as PromptPackConfig["overlays"];

  if (value === undefined) {
    return catalog;
  }

  const record = expectRecord(value, fieldPath);
  assertAllowedKeys(record, PROMPT_OVERLAY_GROUPS, fieldPath);

  for (const group of PROMPT_OVERLAY_GROUPS) {
    catalog[group] = parsePromptAssetMap(
      record[group],
      joinPath(fieldPath, group),
      promptRoot,
    );
  }

  return catalog;
}

function parseProfilePromptSelection(value: unknown, profilePath: string) {
  if (value === undefined) {
    return {
      organizationOverlayNames: [],
      projectOverlayNames: [],
      defaultExperimentName: undefined,
    };
  }

  const promptPath = `${profilePath}.prompt`;
  const prompt = expectRecord(value, promptPath);
  assertAllowedKeys(
    prompt,
    ["organization_overlays", "project_overlays", "default_experiment"],
    promptPath,
  );

  return {
    organizationOverlayNames: dedupeStrings(
      prompt.organization_overlays === undefined
        ? []
        : expectStringArray(
            prompt.organization_overlays,
            `${promptPath}.organization_overlays`,
          ),
    ),
    projectOverlayNames: dedupeStrings(
      prompt.project_overlays === undefined
        ? []
        : expectStringArray(
            prompt.project_overlays,
            `${promptPath}.project_overlays`,
          ),
    ),
    defaultExperimentName:
      prompt.default_experiment === undefined
        ? undefined
        : expectNonEmptyString(
            prompt.default_experiment,
            `${promptPath}.default_experiment`,
          ),
  };
}

function buildPromptSelectionHint(
  promptPack: PromptPackConfig,
  fieldPath: string,
): string | undefined {
  if (fieldPath.endsWith(".organization_overlays")) {
    return buildDefinedNamesHint(promptPack.overlays.organization);
  }

  if (fieldPath.endsWith(".project_overlays")) {
    return buildDefinedNamesHint(promptPack.overlays.project);
  }

  if (fieldPath.endsWith(".default_experiment")) {
    return buildDefinedNamesHint(promptPack.experiments);
  }

  return undefined;
}

function buildDefinedNamesHint(values: Record<string, unknown>): string | undefined {
  const names = Object.keys(values);
  return names.length === 0 ? undefined : `Defined values: ${names.join(", ")}`;
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function parseStringMap(value: unknown, fieldPath: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }

  const record = expectRecord(value, fieldPath);

  return Object.fromEntries(
    Object.entries(record).map(([name, entryValue]) => [
      name,
      expectNonEmptyString(entryValue, joinPath(fieldPath, name)),
    ]),
  );
}

function validatePromptCapabilityRegistry(
  promptCapabilities: Record<string, PromptCapabilityDefinition>,
): void {
  for (const [name, definition] of Object.entries(promptCapabilities)) {
    validatePromptCapabilityDefinition(name, definition);

    for (const requiredCapability of definition.requires) {
      if (!hasOwn(promptCapabilities, requiredCapability)) {
        throw new ConfigError(
          `Prompt capability '${name}' requires unknown capability '${requiredCapability}'.`,
          {
            code: "invalid_value",
            path: `prompt_capabilities.${name}.requires`,
          },
        );
      }
    }

    for (const conflictingCapability of definition.conflictsWith) {
      if (!hasOwn(promptCapabilities, conflictingCapability)) {
        throw new ConfigError(
          `Prompt capability '${name}' conflicts with unknown capability '${conflictingCapability}'.`,
          {
            code: "invalid_value",
            path: `prompt_capabilities.${name}.conflicts_with`,
          },
        );
      }
    }
  }
}

function validatePromptCapabilityDefinition(
  name: string,
  definition: PromptCapabilityDefinition,
): void {
  if (definition.provider === undefined) {
    if (
      definition.surface !== undefined ||
      definition.effect !== undefined ||
      definition.targetScope !== undefined
    ) {
      throw new ConfigError(
        `Prompt capability '${name}' defines GitHub scope metadata without a provider.`,
        {
          code: "invalid_value",
          path: `prompt_capabilities.${name}.provider`,
        },
      );
    }

    return;
  }

  if (definition.provider === "github") {
    validateGitHubCapabilityDefinition(name, definition);
  }
}

function validateGitHubCapabilityDefinition(
  name: string,
  definition: PromptCapabilityDefinition,
): void {
  if (definition.surface === undefined) {
    throw new ConfigError(
      `GitHub prompt capability '${name}' must declare a surface.`,
      {
        code: "invalid_value",
        path: `prompt_capabilities.${name}.surface`,
      },
    );
  }

  if (definition.effect === undefined) {
    throw new ConfigError(
      `GitHub prompt capability '${name}' must declare an effect.`,
      {
        code: "invalid_value",
        path: `prompt_capabilities.${name}.effect`,
      },
    );
  }

  if (definition.targetScope === undefined) {
    throw new ConfigError(
      `GitHub prompt capability '${name}' must declare a target scope.`,
      {
        code: "invalid_value",
        path: `prompt_capabilities.${name}.target_scope`,
      },
    );
  }

  if (definition.allowedRoles.length === 0) {
    throw new ConfigError(
      `GitHub prompt capability '${name}' must declare at least one allowed role.`,
      {
        code: "invalid_value",
        path: `prompt_capabilities.${name}.allowed_roles`,
      },
    );
  }

  if (definition.allowedPhases.length === 0) {
    throw new ConfigError(
      `GitHub prompt capability '${name}' must declare at least one allowed phase.`,
      {
        code: "invalid_value",
        path: `prompt_capabilities.${name}.allowed_phases`,
      },
    );
  }

  if (definition.authority === "behavioral") {
    throw new ConfigError(
      `GitHub prompt capability '${name}' must use an execution-surface authority.`,
      {
        code: "invalid_value",
        path: `prompt_capabilities.${name}.authority`,
      },
    );
  }

  if (
    definition.effect === "read" &&
    definition.authority !== "execution_surface_read"
  ) {
    throw new ConfigError(
      `GitHub read capability '${name}' must use 'execution_surface_read'.`,
      {
        code: "invalid_value",
        path: `prompt_capabilities.${name}.authority`,
      },
    );
  }

  if (
    definition.effect !== "read" &&
    definition.authority !== "execution_surface_write"
  ) {
    throw new ConfigError(
      `GitHub write capability '${name}' must use 'execution_surface_write'.`,
      {
        code: "invalid_value",
        path: `prompt_capabilities.${name}.authority`,
      },
    );
  }

  validateGitHubCapabilityRequiredContext(name, definition);
  validateGitHubCapabilityScopePolicy(name, definition);
}

function validateGitHubCapabilityRequiredContext(
  name: string,
  definition: PromptCapabilityDefinition,
): void {
  const requiredContext = new Set(definition.requiredContext);

  if (
    definition.targetScope === "linked_pull_request" &&
    !requiredContext.has("pull_request_url")
  ) {
    throw new ConfigError(
      `GitHub capability '${name}' targeting a linked pull request must require 'pull_request_url'.`,
      {
        code: "invalid_value",
        path: `prompt_capabilities.${name}.required_context`,
      },
    );
  }

  if (
    (definition.targetScope === "assigned_branch" ||
      definition.targetScope === "pull_request_for_assigned_branch") &&
    !requiredContext.has("assigned_branch")
  ) {
    throw new ConfigError(
      `GitHub capability '${name}' targeting an assigned branch must require 'assigned_branch'.`,
      {
        code: "invalid_value",
        path: `prompt_capabilities.${name}.required_context`,
      },
    );
  }

  if (
    definition.effect !== "read" &&
    !requiredContext.has("write_scope")
  ) {
    throw new ConfigError(
      `GitHub capability '${name}' with write access must require 'write_scope'.`,
      {
        code: "invalid_value",
        path: `prompt_capabilities.${name}.required_context`,
      },
    );
  }
}

function validateGitHubCapabilityScopePolicy(
  name: string,
  definition: PromptCapabilityDefinition,
): void {
  switch (definition.surface) {
    case "pull_request":
      validateAllowedWorkPhases(
        name,
        definition,
        definition.effect === "read"
          ? ["implement", "review", "merge"]
          : ["implement"],
      );
      validateAllowedWorkRoles(
        name,
        definition,
        definition.effect === "read"
          ? ["implement", "review", "merge"]
          : ["implement"],
      );

      if (
        definition.effect === "read" &&
        definition.targetScope !== "linked_pull_request"
      ) {
        throw new ConfigError(
          `GitHub pull-request read capability '${name}' must target the linked pull request.`,
          {
            code: "invalid_value",
            path: `prompt_capabilities.${name}.target_scope`,
          },
        );
      }

      if (
        definition.effect === "write" &&
        definition.targetScope !== "pull_request_for_assigned_branch"
      ) {
        throw new ConfigError(
          `GitHub prompt capability '${name}' must target 'pull_request_for_assigned_branch' when writing pull requests.`,
          {
            code: "invalid_value",
            path: `prompt_capabilities.${name}.target_scope`,
          },
        );
      }
      return;
    case "branch":
      validateAllowedWorkPhases(name, definition, ["implement"]);
      validateAllowedWorkRoles(name, definition, ["implement"]);
      if (definition.targetScope !== "assigned_branch") {
        throw new ConfigError(
          `GitHub branch capability '${name}' must target the assigned branch.`,
          {
            code: "invalid_value",
            path: `prompt_capabilities.${name}.target_scope`,
          },
        );
      }
      return;
    case "review_thread":
      validateAllowedWorkPhases(name, definition, ["implement"]);
      validateAllowedWorkRoles(name, definition, ["implement"]);
      if (definition.targetScope !== "linked_pull_request") {
        throw new ConfigError(
          `GitHub review-thread capability '${name}' must target the linked pull request.`,
          {
            code: "invalid_value",
            path: `prompt_capabilities.${name}.target_scope`,
          },
        );
      }
      if (
        definition.effect !== "write" &&
        definition.effect !== "state_transition"
      ) {
        throw new ConfigError(
          `GitHub review-thread capability '${name}' must use 'write' or 'state_transition'.`,
          {
            code: "invalid_value",
            path: `prompt_capabilities.${name}.effect`,
          },
        );
      }
      return;
    case "review_submission":
      validateAllowedWorkPhases(name, definition, ["review"]);
      validateAllowedWorkRoles(name, definition, ["review"]);
      if (definition.targetScope !== "linked_pull_request") {
        throw new ConfigError(
          `GitHub review submission capability '${name}' must target the linked pull request.`,
          {
            code: "invalid_value",
            path: `prompt_capabilities.${name}.target_scope`,
          },
        );
      }
      if (definition.effect !== "write") {
        throw new ConfigError(
          `GitHub review submission capability '${name}' must use the 'write' effect.`,
          {
            code: "invalid_value",
            path: `prompt_capabilities.${name}.effect`,
          },
        );
      }
      return;
    case "merge":
      validateAllowedWorkPhases(name, definition, ["merge"]);
      validateAllowedWorkRoles(name, definition, ["merge"]);
      if (definition.targetScope !== "linked_pull_request") {
        throw new ConfigError(
          `GitHub merge capability '${name}' must target the linked pull request.`,
          {
            code: "invalid_value",
            path: `prompt_capabilities.${name}.target_scope`,
          },
        );
      }
      if (definition.effect !== "state_transition") {
        throw new ConfigError(
          `GitHub merge capability '${name}' must use the 'state_transition' effect.`,
          {
            code: "invalid_value",
            path: `prompt_capabilities.${name}.effect`,
          },
        );
      }
      return;
  }
}

function validateAllowedWorkPhases(
  name: string,
  definition: PromptCapabilityDefinition,
  allowedPhases: WorkPhase[],
): void {
  const invalidPhases = definition.allowedPhases.filter(
    (phase) => !allowedPhases.includes(phase),
  );

  if (invalidPhases.length > 0) {
    throw new ConfigError(
      `GitHub prompt capability '${name}' is not allowed in phases: ${invalidPhases.join(", ")}.`,
      {
        code: "invalid_value",
        path: `prompt_capabilities.${name}.allowed_phases`,
      },
    );
  }
}

function validateAllowedWorkRoles(
  name: string,
  definition: PromptCapabilityDefinition,
  allowedRoles: WorkPhase[],
): void {
  const invalidRoles = definition.allowedRoles.filter(
    (role) => !allowedRoles.includes(role),
  );

  if (invalidRoles.length > 0) {
    throw new ConfigError(
      `GitHub prompt capability '${name}' is not allowed for roles: ${invalidRoles.join(", ")}.`,
      {
        code: "invalid_value",
        path: `prompt_capabilities.${name}.allowed_roles`,
      },
    );
  }
}

function validatePromptPackCapabilityReferences(
  promptPacks: Record<string, PromptPackConfig>,
  promptCapabilities: Record<string, PromptCapabilityDefinition>,
): void {
  for (const [packName, promptPack] of Object.entries(promptPacks)) {
    const packCapabilityNames = new Set(Object.keys(promptPack.capabilities));
    for (const capabilityName of Object.keys(promptPack.capabilities)) {
      if (!hasOwn(promptCapabilities, capabilityName)) {
        throw new ConfigError(
          `Prompt pack '${packName}' references undefined prompt capability '${capabilityName}'.`,
          {
            code: "invalid_value",
            path: `prompt_packs.${packName}.capabilities.${capabilityName}`,
          },
        );
      }

      const definition = promptCapabilities[capabilityName];
      for (const requiredCapability of definition.requires) {
        if (!packCapabilityNames.has(requiredCapability)) {
          throw new ConfigError(
            `Prompt pack '${packName}' capability '${capabilityName}' requires pack capability '${requiredCapability}'.`,
            {
              code: "invalid_value",
              path: `prompt_packs.${packName}.capabilities.${capabilityName}`,
            },
          );
        }
      }
    }
  }
}

function resolvePromptAssetPath(
  assetPath: string,
  fieldPath: string,
  promptRoot: string,
): string {
  const resolvedPath = resolveFileSystemPath(assetPath, promptRoot, fieldPath);
  assertExistingPromptAsset(resolvedPath, fieldPath);
  return resolvedPath;
}

function assertExistingPromptAsset(
  resolvedPath: string,
  fieldPath: string,
): void {
  let stats: ReturnType<typeof statSync>;

  try {
    stats = statSync(resolvedPath);
  } catch (error) {
    if (isErrnoError(error, "ENOENT")) {
      throw new ConfigError(`Prompt asset '${resolvedPath}' does not exist.`, {
        code: "missing_path",
        path: fieldPath,
        hint: "Create the prompt file or update the configured asset path.",
        cause: error,
      });
    }

    throw new ConfigError(`Failed to inspect prompt asset '${resolvedPath}'.`, {
      code: "config_read_error",
      path: fieldPath,
      cause: error,
    });
  }

  if (!stats.isFile()) {
    throw new ConfigError(
      `Prompt asset '${resolvedPath}' must point to a file.`,
      {
        code: "invalid_value",
        path: fieldPath,
      },
    );
  }
}

function assertPromptAssetHasContent(
  resolvedPath: string,
  fieldPath: string,
): void {
  const contents = readFileSync(resolvedPath, "utf8").trim();

  if (contents.length === 0) {
    throw new ConfigError(`Prompt asset '${resolvedPath}' must not be empty.`, {
      code: "invalid_value",
      path: fieldPath,
    });
  }
}

function resolveFileSystemPath(
  value: string,
  baseDir: string,
  fieldPath: string,
): string {
  if (value.trim() === "") {
    throw new ConfigError("Expected a non-empty path.", {
      code: "invalid_value",
      path: fieldPath,
    });
  }

  return path.resolve(baseDir, value);
}

function expectRequiredRecord(value: unknown, fieldPath: string): ValueRecord {
  if (value === undefined) {
    throw new ConfigError(`Missing required section '${fieldPath}'.`, {
      code: "missing_field",
      path: fieldPath,
    });
  }

  return expectRecord(value, fieldPath);
}

function expectRecord(value: unknown, fieldPath: string): ValueRecord {
  if (!isRecord(value)) {
    throw new ConfigError(
      `Expected '${fieldPath}' to be a table, received ${describeValue(value)}.`,
      {
        code: "invalid_type",
        path: fieldPath,
      },
    );
  }

  return value;
}

function expectNonEmptyString(value: unknown, fieldPath: string): string {
  if (typeof value !== "string") {
    throw new ConfigError(
      `Expected '${fieldPath}' to be a string, received ${describeValue(value)}.`,
      {
        code: "invalid_type",
        path: fieldPath,
      },
    );
  }

  if (value.trim() === "") {
    throw new ConfigError(`Expected '${fieldPath}' to be a non-empty string.`, {
      code: "invalid_value",
      path: fieldPath,
    });
  }

  return value;
}

function expectStringArray(value: unknown, fieldPath: string): string[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(
      `Expected '${fieldPath}' to be an array, received ${describeValue(value)}.`,
      {
        code: "invalid_type",
        path: fieldPath,
      },
    );
  }

  return value.map((entry, index) =>
    expectNonEmptyString(entry, `${fieldPath}[${index}]`),
  );
}

function parsePromptCapabilityAuthority(
  value: unknown,
  fieldPath: string,
): PromptCapabilityAuthority {
  const authority = expectNonEmptyString(value, fieldPath);

  if (!PROMPT_CAPABILITY_AUTHORITY_SET.has(authority)) {
    throw new ConfigError(
      `Unsupported prompt capability authority '${authority}'.`,
      {
        code: "invalid_value",
        path: fieldPath,
        hint: `Supported authorities: ${PROMPT_CAPABILITY_AUTHORITIES.join(", ")}`,
      },
    );
  }

  return authority as PromptCapabilityAuthority;
}

function parseWorkPhaseArray(value: unknown, fieldPath: string): WorkPhase[] {
  if (value === undefined) {
    return [];
  }

  return expectStringArray(value, fieldPath).map((entry, index) => {
    if (!WORK_PHASE_SET.has(entry)) {
      throw new ConfigError(`Unsupported work phase '${entry}'.`, {
        code: "invalid_value",
        path: `${fieldPath}[${index}]`,
        hint: `Supported phases: ${WORK_PHASES.join(", ")}`,
      });
    }

    return entry as WorkPhase;
  });
}

function parsePromptCapabilityContextRequirementArray(
  value: unknown,
  fieldPath: string,
): PromptCapabilityContextRequirement[] {
  if (value === undefined) {
    return [];
  }

  return expectStringArray(value, fieldPath).map((entry, index) => {
    if (!PROMPT_CAPABILITY_CONTEXT_REQUIREMENT_SET.has(entry)) {
      throw new ConfigError(
        `Unsupported prompt capability context requirement '${entry}'.`,
        {
          code: "invalid_value",
          path: `${fieldPath}[${index}]`,
          hint: `Supported requirements: ${PROMPT_CAPABILITY_CONTEXT_REQUIREMENTS.join(", ")}`,
        },
      );
    }

    return entry as PromptCapabilityContextRequirement;
  });
}

function parsePromptCapabilityProvider(
  value: unknown,
  fieldPath: string,
): PromptCapabilityProvider {
  const provider = expectNonEmptyString(value, fieldPath);

  if (!PROMPT_CAPABILITY_PROVIDER_SET.has(provider)) {
    throw new ConfigError(
      `Unsupported prompt capability provider '${provider}'.`,
      {
        code: "invalid_value",
        path: fieldPath,
        hint: `Supported providers: ${PROMPT_CAPABILITY_PROVIDERS.join(", ")}`,
      },
    );
  }

  return provider as PromptCapabilityProvider;
}

function parsePromptCapabilitySurface(
  value: unknown,
  fieldPath: string,
): PromptCapabilitySurface {
  const surface = expectNonEmptyString(value, fieldPath);

  if (!PROMPT_CAPABILITY_SURFACE_SET.has(surface)) {
    throw new ConfigError(
      `Unsupported prompt capability surface '${surface}'.`,
      {
        code: "invalid_value",
        path: fieldPath,
        hint: `Supported surfaces: ${PROMPT_CAPABILITY_SURFACES.join(", ")}`,
      },
    );
  }

  return surface as PromptCapabilitySurface;
}

function parseMergeMethodArray(
  value: unknown,
  fieldPath: string,
): MergeMethod[] {
  const methods = expectStringArray(value, fieldPath).map((method, index) =>
    parseMergeMethod(method, `${fieldPath}[${index}]`),
  );

  if (methods.length === 0) {
    throw new ConfigError(
      `Expected '${fieldPath}' to contain at least one merge method.`,
      {
        code: "invalid_value",
        path: fieldPath,
      },
    );
  }

  return [...new Set(methods)];
}

function parseMergeMethod(
  value: unknown,
  fieldPath: string,
): MergeMethod {
  const method = expectNonEmptyString(value, fieldPath);

  if (!MERGE_METHODS.includes(method as MergeMethod)) {
    throw new ConfigError(`Unsupported merge method '${method}'.`, {
      code: "invalid_value",
      path: fieldPath,
      hint: `Supported merge methods: ${MERGE_METHODS.join(", ")}`,
    });
  }

  return method as MergeMethod;
}

function parsePromptCapabilityEffect(
  value: unknown,
  fieldPath: string,
): PromptCapabilityEffect {
  const effect = expectNonEmptyString(value, fieldPath);

  if (!PROMPT_CAPABILITY_EFFECT_SET.has(effect)) {
    throw new ConfigError(
      `Unsupported prompt capability effect '${effect}'.`,
      {
        code: "invalid_value",
        path: fieldPath,
        hint: `Supported effects: ${PROMPT_CAPABILITY_EFFECTS.join(", ")}`,
      },
    );
  }

  return effect as PromptCapabilityEffect;
}

function parsePromptCapabilityTargetScope(
  value: unknown,
  fieldPath: string,
): PromptCapabilityTargetScope {
  const targetScope = expectNonEmptyString(value, fieldPath);

  if (!PROMPT_CAPABILITY_TARGET_SCOPE_SET.has(targetScope)) {
    throw new ConfigError(
      `Unsupported prompt capability target scope '${targetScope}'.`,
      {
        code: "invalid_value",
        path: fieldPath,
        hint: `Supported target scopes: ${PROMPT_CAPABILITY_TARGET_SCOPES.join(", ")}`,
      },
    );
  }

  return targetScope as PromptCapabilityTargetScope;
}

function expectBoolean(value: unknown, fieldPath: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConfigError(
      `Expected '${fieldPath}' to be a boolean, received ${describeValue(value)}.`,
      {
        code: "invalid_type",
        path: fieldPath,
      },
    );
  }

  return value;
}

function expectInteger(
  value: unknown,
  fieldPath: string,
  options: { min?: number } = {},
): number {
  const numericValue = normalizeInteger(value, fieldPath);

  if (options.min !== undefined && numericValue < options.min) {
    throw new ConfigError(
      `Expected '${fieldPath}' to be at least ${options.min}, received ${numericValue}.`,
      {
        code: "invalid_value",
        path: fieldPath,
      },
    );
  }

  return numericValue;
}

function normalizeInteger(value: unknown, fieldPath: string): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new ConfigError(
        `Expected '${fieldPath}' to be an integer, received ${value}.`,
        {
          code: "invalid_value",
          path: fieldPath,
        },
      );
    }

    return value;
  }

  if (typeof value === "bigint") {
    const numericValue = Number(value);

    if (!Number.isSafeInteger(numericValue)) {
      throw new ConfigError(
        `Expected '${fieldPath}' to fit in a safe integer range.`,
        {
          code: "invalid_value",
          path: fieldPath,
        },
      );
    }

    return numericValue;
  }

  throw new ConfigError(
    `Expected '${fieldPath}' to be an integer, received ${describeValue(value)}.`,
    {
      code: "invalid_type",
      path: fieldPath,
    },
  );
}

function readOptionalString(
  record: ValueRecord,
  key: string,
  parentPath: string,
): string | undefined {
  const value = record[key];

  if (value === undefined) {
    return undefined;
  }

  return expectNonEmptyString(value, joinPath(parentPath, key));
}

function assertAllowedKeys(
  record: ValueRecord,
  allowedKeys: readonly string[],
  fieldPath: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      const fullPath = joinPath(fieldPath, key);
      throw new ConfigError(`Unknown field '${fullPath}'.`, {
        code: "unknown_key",
        path: fullPath,
        hint: `Allowed fields: ${allowedKeys.join(", ")}`,
      });
    }
  }
}

function assertNonEmptyNamedSection(record: ValueRecord, fieldPath: string): void {
  if (Object.keys(record).length === 0) {
    throw new ConfigError(`Section '${fieldPath}' must define at least one entry.`, {
      code: "missing_field",
      path: fieldPath,
    });
  }
}

function joinPath(parentPath: string, key: string): string {
  return parentPath === "" ? key : `${parentPath}.${key}`;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is ValueRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value;
}

function isErrnoError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
