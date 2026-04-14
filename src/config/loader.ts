import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

import { ConfigError } from "./errors.js";
import {
  type BuiltinProviderKind,
  BUILTIN_PROVIDER_KINDS,
  type ContextLocalFilesProviderConfig,
  type ContextNotionProviderConfig,
  type ContextProviderConfig,
  type LoadConfigOptions,
  type LoadedConfig,
  type ParseConfigOptions,
  type PathsConfig,
  type PlanningLinearProviderConfig,
  type PlanningLocalFilesProviderConfig,
  type PlanningProviderConfig,
  type PolicyConfig,
  type ProfileConfig,
  type PromptPackConfig,
  type PromptsConfig,
  type ProviderConfig,
} from "./types.js";

type ValueRecord = Record<string, unknown>;

const TOP_LEVEL_KEYS = [
  "version",
  "active_profile",
  "paths",
  "policy",
  "prompts",
  "prompt_packs",
  "providers",
  "profiles",
] as const;

const PROVIDER_KIND_SET = new Set<string>(BUILTIN_PROVIDER_KINDS);
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const POLICY_DEFAULTS: PolicyConfig = {
  maxConcurrentRuns: 4,
  maxRunsPerProvider: 2,
  allowMixedProviders: true,
  defaultPhaseTimeoutSec: 5400,
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
  const policy = parsePolicySection(document.policy);
  const prompts = parsePromptsSection(document.prompts, configDir);
  const promptPacks = parsePromptPacksSection(document.prompt_packs, prompts.root);

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
    policy,
    prompts,
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
  };
}

function parsePromptsSection(value: unknown, configDir: string): PromptsConfig {
  const section = expectRequiredRecord(value, "prompts");
  assertAllowedKeys(section, ["root", "active_pack"], "prompts");

  const activePack =
    section.active_pack === undefined
      ? undefined
      : expectNonEmptyString(section.active_pack, "prompts.active_pack");

  return {
    root: resolveFileSystemPath(
      expectNonEmptyString(section.root, "prompts.root"),
      configDir,
      "prompts.root",
    ),
    activePack,
  };
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
          overlays: parsePromptAssetListMap(
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

      assertAllowedKeys(profile, ["planning", "context", "prompt_pack"], profilePath);

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

function parsePromptAssetListMap(
  value: unknown,
  fieldPath: string,
  promptRoot: string,
): Record<string, string[]> {
  if (value === undefined) {
    return {};
  }

  const record = expectRecord(value, fieldPath);

  return Object.fromEntries(
    Object.entries(record).map(([name, entryValue]) => {
      const entryPath = joinPath(fieldPath, name);
      const entries = expectStringArray(entryValue, entryPath);

      return [
        name,
        entries.map((entry, index) =>
          resolvePromptAssetPath(entry, `${entryPath}[${index}]`, promptRoot),
        ),
      ];
    }),
  );
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
