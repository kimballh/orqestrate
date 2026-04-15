import { existsSync, realpathSync } from "node:fs";
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
): PackageAssetPaths {
  const packageRoot = resolvePackageRoot(moduleUrl);
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

export function resolvePackageRoot(moduleUrl: string = import.meta.url): string {
  let currentPath = path.dirname(resolveRealPath(fileURLToPath(moduleUrl)));

  while (true) {
    if (existsSync(path.join(currentPath, "package.json"))) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error(
        `Unable to resolve the package root for module '${moduleUrl}'.`,
      );
    }

    currentPath = parentPath;
  }
}

function resolveRealPath(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}
