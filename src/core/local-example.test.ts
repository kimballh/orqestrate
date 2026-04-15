import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../config/loader.js";
import { LocalFilesContextBackend } from "../providers/context/local-files-backend.js";
import { LocalFilesPlanningBackend } from "../providers/planning/local-files-backend.js";
import {
  materializeLocalExampleForProfile,
  resolveLocalExamplePaths,
  validateLocalExampleAssets,
} from "./local-example.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

test("validates the shipped local example seed and template pack", async () => {
  const result = await validateLocalExampleAssets(REPO_ROOT);

  assert.equal(result.issueCount, 3);
  assert.equal(result.actionableCount, 1);
});

test("materializes the local example into a configured local profile workspace", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "orq-local-example-fixture-"));
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  await copyFixtureFile(
    path.join(REPO_ROOT, "config.example.toml"),
    path.join(fixtureRoot, "config.example.toml"),
  );
  await cp(
    path.join(REPO_ROOT, "docs", "prompts"),
    path.join(fixtureRoot, "docs", "prompts"),
    { recursive: true },
  );

  const examplePaths = resolveLocalExamplePaths(REPO_ROOT);

  await Promise.all([
    copyFixtureFile(
      path.join(examplePaths.planningSeedRoot, "index.json"),
      path.join(fixtureRoot, "examples", "local", "seed", "planning", "index.json"),
    ),
    copyFixtureFile(
      path.join(examplePaths.planningIssuesRoot, "LOCAL-001.json"),
      path.join(
        fixtureRoot,
        "examples",
        "local",
        "seed",
        "planning",
        "issues",
        "LOCAL-001.json",
      ),
    ),
    copyFixtureFile(
      path.join(examplePaths.planningIssuesRoot, "LOCAL-002.json"),
      path.join(
        fixtureRoot,
        "examples",
        "local",
        "seed",
        "planning",
        "issues",
        "LOCAL-002.json",
      ),
    ),
    copyFixtureFile(
      path.join(examplePaths.planningIssuesRoot, "LOCAL-003.json"),
      path.join(
        fixtureRoot,
        "examples",
        "local",
        "seed",
        "planning",
        "issues",
        "LOCAL-003.json",
      ),
    ),
    copyFixtureFile(
      examplePaths.artifactTemplatePath,
      path.join(
        fixtureRoot,
        "examples",
        "local",
        "context",
        "templates",
        "artifact.md",
      ),
    ),
    copyFixtureFile(
      examplePaths.evidenceTemplatePath,
      path.join(
        fixtureRoot,
        "examples",
        "local",
        "context",
        "templates",
        "evidence.md",
      ),
    ),
  ]);

  const loadedConfig = await loadConfig({
    configPath: path.join(fixtureRoot, "config.example.toml"),
    env: {},
  });
  const materialized = await materializeLocalExampleForProfile(loadedConfig, {
    repoRoot: fixtureRoot,
  });

  assert.equal(materialized.planningSeedState, "seeded");
  assert.equal(materialized.actionableCount, 1);

  const planningProvider = loadedConfig.activeProfile.planningProvider;
  const contextProvider = loadedConfig.activeProfile.contextProvider;

  if (planningProvider.kind !== "planning.local_files") {
    throw new Error("expected the fixture profile to use planning.local_files");
  }

  if (contextProvider.kind !== "context.local_files") {
    throw new Error("expected the fixture profile to use context.local_files");
  }

  const planningBackend = new LocalFilesPlanningBackend(planningProvider);
  await planningBackend.validateConfig();
  const actionable = await planningBackend.listActionableWorkItems({ limit: 10 });

  assert.deepEqual(actionable.map((item) => item.id), ["LOCAL-001"]);

  const contextBackend = new LocalFilesContextBackend(contextProvider);
  await contextBackend.validateConfig();

  const index = JSON.parse(
    await readFile(path.join(planningProvider.root, "index.json"), "utf8"),
  ) as { items: Array<{ id: string }> };

  assert.deepEqual(index.items.map((item) => item.id), [
    "LOCAL-001",
    "LOCAL-002",
    "LOCAL-003",
  ]);
});

test("force materialization resets stale local context state", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "orq-local-example-force-"));
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  await copyFixtureFile(
    path.join(REPO_ROOT, "config.example.toml"),
    path.join(fixtureRoot, "config.example.toml"),
  );
  await cp(
    path.join(REPO_ROOT, "docs", "prompts"),
    path.join(fixtureRoot, "docs", "prompts"),
    { recursive: true },
  );
  await cp(
    path.join(REPO_ROOT, "examples", "local"),
    path.join(fixtureRoot, "examples", "local"),
    { recursive: true },
  );

  const loadedConfig = await loadConfig({
    configPath: path.join(fixtureRoot, "config.example.toml"),
    env: {},
  });
  const contextProvider = loadedConfig.activeProfile.contextProvider;

  if (contextProvider.kind !== "context.local_files") {
    throw new Error("expected the fixture profile to use context.local_files");
  }

  await materializeLocalExampleForProfile(loadedConfig, { repoRoot: fixtureRoot });
  await mkdir(path.join(contextProvider.root, "artifacts"), { recursive: true });
  await writeFile(
    path.join(contextProvider.root, "artifacts", "LOCAL-999.md"),
    "stale artifact\n",
    "utf8",
  );

  await materializeLocalExampleForProfile(loadedConfig, {
    repoRoot: fixtureRoot,
    overwrite: true,
  });

  await assert.rejects(() =>
    readFile(path.join(contextProvider.root, "artifacts", "LOCAL-999.md"), "utf8"),
  );
});

async function copyFixtureFile(sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
}
