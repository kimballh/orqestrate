import os from "node:os";
import path from "node:path";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";

import type {
  ContextLocalFilesProviderConfig,
  LoadedConfig,
  PlanningLocalFilesProviderConfig,
} from "../config/types.js";
import { LocalFilesContextBackend } from "../providers/context/local-files-backend.js";
import { LocalFilesPlanningBackend } from "../providers/planning/local-files-backend.js";

const LOCAL_EXAMPLE_DIRECTORY = path.join("examples", "local");
const LOCAL_PLANNING_SEED_DIRECTORY = path.join("seed", "planning");
const LOCAL_CONTEXT_TEMPLATE_DIRECTORY = path.join("context", "templates");
const LOCAL_ARTIFACT_TEMPLATE_FILE = "artifact.md";
const LOCAL_EVIDENCE_TEMPLATE_FILE = "evidence.md";

export type LocalExamplePaths = {
  exampleRoot: string;
  planningSeedRoot: string;
  planningIssuesRoot: string;
  planningIndexPath: string;
  contextTemplatesRoot: string;
  artifactTemplatePath: string;
  evidenceTemplatePath: string;
};

export type LocalExampleValidationResult = {
  issueCount: number;
  actionableCount: number;
};

export type LocalExampleMaterializationResult = {
  sourceExampleRoot: string;
  planningRoot: string;
  planningSeedState: "seeded" | "existing";
  contextRoot: string;
  issueCount: number;
  actionableCount: number;
};

export type MaterializeLocalExampleOptions = {
  repoRoot?: string;
  overwrite?: boolean;
};

export function resolveLocalExamplePaths(repoRoot: string): LocalExamplePaths {
  const exampleRoot = path.join(repoRoot, LOCAL_EXAMPLE_DIRECTORY);
  const planningSeedRoot = path.join(exampleRoot, LOCAL_PLANNING_SEED_DIRECTORY);
  const contextTemplatesRoot = path.join(
    exampleRoot,
    LOCAL_CONTEXT_TEMPLATE_DIRECTORY,
  );

  return {
    exampleRoot,
    planningSeedRoot,
    planningIssuesRoot: path.join(planningSeedRoot, "issues"),
    planningIndexPath: path.join(planningSeedRoot, "index.json"),
    contextTemplatesRoot,
    artifactTemplatePath: path.join(
      contextTemplatesRoot,
      LOCAL_ARTIFACT_TEMPLATE_FILE,
    ),
    evidenceTemplatePath: path.join(
      contextTemplatesRoot,
      LOCAL_EVIDENCE_TEMPLATE_FILE,
    ),
  };
}

export async function validateLocalExampleAssets(
  repoRoot: string,
): Promise<LocalExampleValidationResult> {
  const paths = resolveLocalExamplePaths(repoRoot);
  const tempPlanningRoot = await mkdtemp(
    path.join(os.tmpdir(), "orq-local-example-seed-"),
  );
  const tempContextRoot = await mkdtemp(
    path.join(os.tmpdir(), "orq-local-example-context-"),
  );

  try {
    await assertLocalExampleFilesExist(paths);

    const issueFileNames = await copyPlanningSeedIssues(
      paths.planningIssuesRoot,
      tempPlanningRoot,
    );
    const planningBackend = createPlanningBackend(tempPlanningRoot);
    await planningBackend.validateConfig();

    const actualIndex = JSON.parse(
      await readFile(path.join(tempPlanningRoot, "index.json"), "utf8"),
    );
    const expectedIndex = JSON.parse(
      await readFile(paths.planningIndexPath, "utf8"),
    );

    if (JSON.stringify(actualIndex) !== JSON.stringify(expectedIndex)) {
      throw new Error(
        `Local example planning seed index '${paths.planningIndexPath}' is stale or mismatched.`,
      );
    }

    const actionableWorkItems = await planningBackend.listActionableWorkItems({
      limit: Math.max(1, issueFileNames.length),
    });

    if (actionableWorkItems.length === 0) {
      throw new Error(
        `Local example planning seed under '${paths.planningSeedRoot}' must include at least one actionable work item.`,
      );
    }

    const contextBackend = createContextBackend(tempContextRoot, {
      artifact_template: paths.artifactTemplatePath,
      run_template: paths.evidenceTemplatePath,
    });
    await contextBackend.validateConfig();

    return {
      issueCount: issueFileNames.length,
      actionableCount: actionableWorkItems.length,
    };
  } finally {
    await Promise.all([
      rm(tempPlanningRoot, { recursive: true, force: true }),
      rm(tempContextRoot, { recursive: true, force: true }),
    ]);
  }
}

export async function materializeLocalExampleForProfile(
  loadedConfig: LoadedConfig,
  options: MaterializeLocalExampleOptions = {},
): Promise<LocalExampleMaterializationResult> {
  const repoRoot =
    options.repoRoot ?? path.resolve(path.dirname(loadedConfig.sourcePath), "..");
  const planningProvider = requireLocalPlanningProvider(loadedConfig);
  const contextProvider = requireLocalContextProvider(loadedConfig);
  const validation = await validateLocalExampleAssets(repoRoot);
  const examplePaths = resolveLocalExamplePaths(repoRoot);

  let planningSeedState: "seeded" | "existing" = "seeded";

  if (options.overwrite === true) {
    await rm(planningProvider.root, { recursive: true, force: true });
  } else {
    const existingIssueFileNames = await listJsonFiles(
      path.join(planningProvider.root, "issues"),
    );

    if (existingIssueFileNames.length > 0) {
      planningSeedState = "existing";
    }
  }

  if (planningSeedState === "seeded") {
    await rm(planningProvider.root, { recursive: true, force: true });
    await copyPlanningSeedIssues(examplePaths.planningIssuesRoot, planningProvider.root);
  }

  const planningBackend = createPlanningBackend(planningProvider.root);
  await planningBackend.validateConfig();
  const actionableWorkItems = await planningBackend.listActionableWorkItems({
    limit: Math.max(1, validation.issueCount),
  });

  if (actionableWorkItems.length === 0) {
    throw new Error(
      `Materialized planning root '${planningProvider.root}' does not contain any actionable local work items.`,
    );
  }

  const contextBackend = createContextBackend(
    contextProvider.root,
    contextProvider.templates,
  );
  await contextBackend.validateConfig();

  return {
    sourceExampleRoot: examplePaths.exampleRoot,
    planningRoot: planningProvider.root,
    planningSeedState,
    contextRoot: contextProvider.root,
    issueCount: validation.issueCount,
    actionableCount: actionableWorkItems.length,
  };
}

function requireLocalPlanningProvider(
  loadedConfig: LoadedConfig,
): PlanningLocalFilesProviderConfig {
  const provider = loadedConfig.activeProfile.planningProvider;

  if (provider.kind !== "planning.local_files") {
    throw new Error(
      `Local example materialization requires a planning.local_files provider, received '${provider.kind}'.`,
    );
  }

  return provider;
}

function requireLocalContextProvider(
  loadedConfig: LoadedConfig,
): ContextLocalFilesProviderConfig {
  const provider = loadedConfig.activeProfile.contextProvider;

  if (provider.kind !== "context.local_files") {
    throw new Error(
      `Local example materialization requires a context.local_files provider, received '${provider.kind}'.`,
    );
  }

  return provider;
}

async function assertLocalExampleFilesExist(paths: LocalExamplePaths): Promise<void> {
  const files = [
    paths.planningIndexPath,
    paths.artifactTemplatePath,
    paths.evidenceTemplatePath,
  ];

  for (const filePath of files) {
    await readFile(filePath, "utf8").catch(() => {
      throw new Error(`Required local example file '${filePath}' does not exist.`);
    });
  }

  const issueFileNames = await listJsonFiles(paths.planningIssuesRoot);

  if (issueFileNames.length === 0) {
    throw new Error(
      `Local example planning seed '${paths.planningIssuesRoot}' must contain at least one issue JSON file.`,
    );
  }
}

async function copyPlanningSeedIssues(
  sourceIssuesRoot: string,
  targetPlanningRoot: string,
): Promise<string[]> {
  const issueFileNames = await listJsonFiles(sourceIssuesRoot);
  const targetIssuesRoot = path.join(targetPlanningRoot, "issues");

  await mkdir(targetIssuesRoot, { recursive: true });

  for (const fileName of issueFileNames) {
    await copyFile(
      path.join(sourceIssuesRoot, fileName),
      path.join(targetIssuesRoot, fileName),
    );
  }

  return issueFileNames;
}

async function listJsonFiles(directoryPath: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function createPlanningBackend(root: string): LocalFilesPlanningBackend {
  return new LocalFilesPlanningBackend({
    name: "local_example_planning",
    family: "planning",
    kind: "planning.local_files",
    root,
  });
}

function createContextBackend(
  root: string,
  templates: Record<string, string>,
): LocalFilesContextBackend {
  return new LocalFilesContextBackend({
    name: "local_example_context",
    family: "context",
    kind: "context.local_files",
    root,
    templates,
  });
}
