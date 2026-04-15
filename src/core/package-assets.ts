import { existsSync, lstatSync, readlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type PackageAssetPaths = {
  packageRoot: string;
  configExamplePath: string;
  promptsRoot: string;
  localExampleRoot: string;
  planningSeedRoot: string;
  contextTemplatesRoot: string;
  artifactTemplatePath: string;
  evidenceTemplatePath: string;
  runtimeSqlRoot: string;
  orchestratorSqlRoot: string;
};

export function resolvePackageAssetPaths(
  moduleUrl: string = import.meta.url,
  entryPath?: string,
): PackageAssetPaths {
  const packageRoot = resolvePackageRoot(moduleUrl, entryPath);
  return buildPackageAssetPaths(packageRoot);
}

export function resolveWorkspacePackageAssetPaths(
  workingDirectory: string,
  moduleUrl: string = import.meta.url,
  entryPath?: string,
): PackageAssetPaths {
  const localInstallRoot = path.join(
    workingDirectory,
    "node_modules",
    "orqestrate",
  );

  if (hasPackageMarkers(localInstallRoot)) {
    return buildPackageAssetPaths(localInstallRoot);
  }

  return resolvePackageAssetPaths(moduleUrl, entryPath);
}

function buildPackageAssetPaths(packageRoot: string): PackageAssetPaths {
  const localExampleRoot = path.join(packageRoot, "examples", "local");
  const contextTemplatesRoot = path.join(
    localExampleRoot,
    "context",
    "templates",
  );

  return {
    packageRoot,
    configExamplePath: path.join(packageRoot, "config.example.toml"),
    promptsRoot: path.join(packageRoot, "docs", "prompts"),
    localExampleRoot,
    planningSeedRoot: path.join(localExampleRoot, "seed", "planning"),
    contextTemplatesRoot,
    artifactTemplatePath: path.join(contextTemplatesRoot, "artifact.md"),
    evidenceTemplatePath: path.join(contextTemplatesRoot, "evidence.md"),
    runtimeSqlRoot: path.join(packageRoot, "dist", "runtime", "persistence", "sql"),
    orchestratorSqlRoot: path.join(packageRoot, "dist", "orchestrator", "sql"),
  };
}

export function resolvePackageRoot(
  moduleUrl: string = import.meta.url,
  entryPath?: string,
): string {
  const candidatePaths = buildCandidatePaths(moduleUrl, entryPath);

  for (const candidatePath of candidatePaths) {
    const packageRoot = findPackageRoot(candidatePath);
    if (packageRoot !== null && hasPackageMarkers(packageRoot)) {
      return packageRoot;
    }
  }

  for (const candidatePath of candidatePaths) {
    const packageRoot = findPackageRoot(candidatePath);
    if (packageRoot !== null) {
      return packageRoot;
    }
  }

  throw new Error(`Unable to resolve the package root for module '${moduleUrl}'.`);
}

function buildCandidatePaths(moduleUrl: string, entryPath?: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  if (entryPath !== undefined) {
    for (const candidate of resolveEntryCandidates(entryPath)) {
      if (!seen.has(candidate)) {
        candidates.push(candidate);
        seen.add(candidate);
      }
    }
  }

  const modulePath = path.resolve(fileURLToPath(moduleUrl));
  if (!seen.has(modulePath)) {
    candidates.push(modulePath);
  }

  return candidates;
}

function resolveEntryCandidates(entryPath: string): string[] {
  const resolvedEntryPath = path.resolve(entryPath);
  const candidates = [resolvedEntryPath];

  try {
    if (lstatSync(resolvedEntryPath).isSymbolicLink()) {
      candidates.push(
        path.resolve(path.dirname(resolvedEntryPath), readlinkSync(resolvedEntryPath)),
      );
    }
  } catch {
    // Ignore missing or unreadable entry paths and fall back to moduleUrl.
  }

  return candidates;
}

function findPackageRoot(candidatePath: string): string | null {
  let currentPath = path.dirname(candidatePath);

  while (true) {
    if (existsSync(path.join(currentPath, "package.json"))) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }

    currentPath = parentPath;
  }
}

function hasPackageMarkers(packageRoot: string): boolean {
  return (
    existsSync(path.join(packageRoot, "config.example.toml")) &&
    existsSync(path.join(packageRoot, "docs", "prompts")) &&
    existsSync(path.join(packageRoot, "examples", "local"))
  );
}
