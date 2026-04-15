import path from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";

import { loadConfig } from "../config/loader.js";
import type { LoadConfigOptions, LoadedConfig } from "../config/types.js";

import {
  bootstrapActiveProfile,
  type BootstrapReport,
} from "./bootstrap.js";
import {
  materializeLocalExampleForProfile,
  type LocalExampleMaterializationResult,
} from "./local-example.js";
import {
  resolvePackageAssetPaths,
  type PackageAssetPaths,
} from "./package-assets.js";

export type InitializeWorkspaceOptions = {
  cwd?: string;
  configPath?: string;
  profile?: string;
  force?: boolean;
  env?: LoadConfigOptions["env"];
};

export type InitializeWorkspaceResult = {
  workingDirectory: string;
  exampleConfigPath: string;
  configPath: string;
  profileName: string;
  overwritten: boolean;
};

export type BootstrapWorkspaceOptions = {
  cwd?: string;
  configPath?: string;
  profile?: string;
  force?: boolean;
  env?: LoadConfigOptions["env"];
  runHealthChecks?: boolean;
};

export type BootstrapWorkspaceResult = {
  workingDirectory: string;
  configPath: string;
  profileName: string;
  localExample: LocalExampleMaterializationResult | null;
  bootstrapReport: BootstrapReport;
};

export async function initializeWorkspace(
  options: InitializeWorkspaceOptions = {},
): Promise<InitializeWorkspaceResult> {
  const workingDirectory = resolveWorkingDirectory(options.cwd);
  const assetPaths = resolvePackageAssetPaths();
  const exampleConfigPath = assetPaths.configExamplePath;
  const configPath = resolveConfigPath(workingDirectory, options.configPath);
  const exampleConfig = await loadConfig({
    cwd: workingDirectory,
    configPath: exampleConfigPath,
    env: options.env ?? {},
  });
  const profileName = options.profile ?? exampleConfig.activeProfileName;

  if (!Object.hasOwn(exampleConfig.profiles, profileName)) {
    throw new Error(
      `Profile '${profileName}' does not exist in '${exampleConfigPath}'.`,
    );
  }

  const existingConfig = await pathExists(configPath);

  if (existingConfig && options.force !== true) {
    throw new Error(
      `Config file '${configPath}' already exists. Re-run with --force to overwrite it.`,
    );
  }

  const configSource = await readFile(exampleConfigPath, "utf8");
  const initializedConfigSource = prepareInitializedConfig(
    configSource,
    profileName,
    assetPaths,
  );

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, initializedConfigSource, "utf8");

  return {
    workingDirectory,
    exampleConfigPath,
    configPath,
    profileName,
    overwritten: existingConfig,
  };
}

export async function bootstrapWorkspace(
  options: BootstrapWorkspaceOptions = {},
): Promise<BootstrapWorkspaceResult> {
  const workingDirectory = resolveWorkingDirectory(options.cwd);
  const assetPaths = resolvePackageAssetPaths();
  const loadedConfig = await loadConfig({
    cwd: workingDirectory,
    configPath: options.configPath,
    activeProfile: options.profile,
    env: options.env,
  });
  const localExample = shouldMaterializeLocalExample(loadedConfig)
    ? await materializeLocalExampleForProfile(loadedConfig, {
        repoRoot: assetPaths.packageRoot,
        overwrite: options.force,
      })
    : null;
  const bootstrapped = await bootstrapActiveProfile(loadedConfig, {
    runHealthChecks: options.runHealthChecks,
  });

  return {
    workingDirectory,
    configPath: loadedConfig.sourcePath,
    profileName: loadedConfig.activeProfileName,
    localExample,
    bootstrapReport: bootstrapped.report,
  };
}

function shouldMaterializeLocalExample(loadedConfig: LoadedConfig): boolean {
  return (
    loadedConfig.activeProfile.planningProvider.kind === "planning.local_files" &&
    loadedConfig.activeProfile.contextProvider.kind === "context.local_files"
  );
}

function resolveWorkingDirectory(cwd?: string): string {
  return path.resolve(cwd ?? process.cwd());
}

function resolveConfigPath(workingDirectory: string, configPath?: string): string {
  return configPath === undefined
    ? path.join(workingDirectory, "config.toml")
    : path.resolve(workingDirectory, configPath);
}

function prepareInitializedConfig(
  source: string,
  profileName: string,
  assetPaths: PackageAssetPaths,
): string {
  const activeProfilePattern = /^active_profile = "[^"]+"$/m;

  if (!activeProfilePattern.test(source)) {
    throw new Error("config.example.toml is missing an active_profile declaration.");
  }

  return replaceRequiredConfigValue(
    replaceRequiredConfigValue(
      replaceRequiredConfigValue(
        source.replace(
          activeProfilePattern,
          `active_profile = ${formatTomlString(profileName)}`,
        ),
        /^root = "\.\/docs\/prompts"$/m,
        `root = ${formatTomlString(assetPaths.promptsRoot)}`,
        "config.example.toml is missing the canonical prompts root.",
      ),
      /^artifact_template = "\.\/examples\/local\/context\/templates\/artifact\.md"$/m,
      `artifact_template = ${formatTomlString(assetPaths.artifactTemplatePath)}`,
      "config.example.toml is missing the local artifact template path.",
    ),
    /^run_template = "\.\/examples\/local\/context\/templates\/evidence\.md"$/m,
    `run_template = ${formatTomlString(assetPaths.evidenceTemplatePath)}`,
    "config.example.toml is missing the local evidence template path.",
  );
}

async function pathExists(targetPath: string): Promise<boolean> {
  return stat(targetPath)
    .then(() => true)
    .catch(() => false);
}

function replaceRequiredConfigValue(
  source: string,
  pattern: RegExp,
  replacement: string,
  missingMessage: string,
): string {
  if (!pattern.test(source)) {
    throw new Error(missingMessage);
  }

  return source.replace(pattern, replacement);
}

function formatTomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}
