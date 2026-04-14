import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigError } from "./errors.js";
import { loadConfig, parseConfig } from "./loader.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const VALID_CONFIG = `version = 1
active_profile = "local"

[paths]
state_dir = ".harness/state"
data_dir = ".harness/data"
log_dir = ".harness/logs"

[policy]
max_concurrent_runs = 8

[prompts]
root = "./prompts"
active_pack = "default"

[prompt_packs.default]
base_system = "base/system.md"

[prompt_packs.default.roles]
design = "roles/design.md"
implement = "roles/implement.md"

[providers.linear_main]
kind = "planning.linear"
token_env = "LINEAR_API_KEY"
team = "ENG"

[providers.notion_main]
kind = "context.notion"
token_env = "NOTION_TOKEN"
artifacts_database_id = "artifacts-db"
runs_database_id = "runs-db"

[providers.local_planning]
kind = "planning.local_files"
root = ".harness/local/planning"

[providers.local_context]
kind = "context.local_files"
root = ".harness/local/context"

[profiles.saas]
planning = "linear_main"
context = "notion_main"
prompt_pack = "default"

[profiles.local]
planning = "local_planning"
context = "local_context"

[profiles.hybrid]
planning = "linear_main"
context = "local_context"
`;

test("loads the docs example with its default local profile without SaaS env vars", async () => {
  const config = await loadConfig({
    configPath: path.join(REPO_ROOT, "docs/config.example.toml"),
    env: {},
  });

  assert.equal(config.activeProfileName, "local");
  assert.equal(config.activeProfile.planningProvider.kind, "planning.local_files");
  assert.equal(config.activeProfile.contextProvider.kind, "context.local_files");
  assert.equal(
    config.activeProfile.promptPack.baseSystem,
    path.join(REPO_ROOT, "docs", "prompts", "base", "system.md"),
  );
});

test("loads the docs example for the saas profile when required env vars exist", async () => {
  const config = await loadConfig({
    configPath: path.join(REPO_ROOT, "docs/config.example.toml"),
    activeProfile: "saas",
    env: {
      LINEAR_API_KEY: "linear-token",
      LINEAR_WEBHOOK_SECRET: "webhook-secret",
      NOTION_TOKEN: "notion-token",
    },
  });

  assert.equal(config.activeProfileName, "saas");
  assert.equal(config.activeProfile.planningProvider.kind, "planning.linear");
  assert.equal(config.activeProfile.contextProvider.kind, "context.notion");
});

test("activeProfile override takes precedence over the file default", () => {
  const fixture = createFixtureWorkspace();
  const config = parseConfig(VALID_CONFIG, {
    sourcePath: fixture.sourcePath,
    activeProfile: "hybrid",
    env: {
      LINEAR_API_KEY: "linear-token",
    },
  });

  assert.equal(config.activeProfileName, "hybrid");
  assert.equal(config.activeProfile.promptPackName, "default");
  assert.equal(config.activeProfile.planningProvider.name, "linear_main");
  assert.equal(config.activeProfile.contextProvider.name, "local_context");
});

test("normalizes relative filesystem and prompt asset paths against the config location", () => {
  const fixture = createFixtureWorkspace();
  const config = parseConfig(VALID_CONFIG, {
    sourcePath: fixture.sourcePath,
    env: {},
  });

  assert.equal(
    config.paths.stateDir,
    path.join(fixture.workspaceDir, ".harness", "state"),
  );
  assert.equal(config.activeProfile.planningProvider.kind, "planning.local_files");
  assert.equal(
    config.activeProfile.planningProvider.root,
    path.join(fixture.workspaceDir, ".harness", "local", "planning"),
  );
  assert.equal(
    config.promptPacks.default.baseSystem,
    path.join(fixture.workspaceDir, "prompts", "base", "system.md"),
  );
  assert.equal(
    config.promptPacks.default.roles.implement,
    path.join(fixture.workspaceDir, "prompts", "roles", "implement.md"),
  );
});

test("rejects unsupported provider kinds", () => {
  const fixture = createFixtureWorkspace();
  assert.throws(
    () =>
      parseConfig(
        VALID_CONFIG.replace(
          'kind = "planning.linear"',
          'kind = "planning.unknown"',
        ),
        {
          sourcePath: fixture.sourcePath,
          env: {},
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "unsupported_provider_kind");
      assert.equal(error.path, "providers.linear_main.kind");
      return true;
    },
  );
});

test("rejects unknown provider references in profiles", () => {
  const fixture = createFixtureWorkspace();
  assert.throws(
    () =>
      parseConfig(
        VALID_CONFIG.replace(
          'planning = "linear_main"',
          'planning = "missing_planning"',
        ),
        {
          sourcePath: fixture.sourcePath,
          activeProfile: "saas",
          env: {},
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "unknown_provider_reference");
      assert.equal(error.path, "profiles.saas.planning");
      return true;
    },
  );
});

test("rejects planning/context role mismatches", () => {
  const fixture = createFixtureWorkspace();
  assert.throws(
    () =>
      parseConfig(
        VALID_CONFIG.replace('planning = "linear_main"', 'planning = "notion_main"'),
        {
          sourcePath: fixture.sourcePath,
          activeProfile: "saas",
          env: {},
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "provider_role_mismatch");
      assert.equal(error.path, "profiles.saas.planning");
      return true;
    },
  );
});

test("fails clearly when the selected profile is missing a required env var", () => {
  const fixture = createFixtureWorkspace();
  assert.throws(
    () =>
      parseConfig(VALID_CONFIG, {
        sourcePath: fixture.sourcePath,
        activeProfile: "saas",
        env: {
          LINEAR_API_KEY: "linear-token",
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "missing_env_var");
      assert.equal(error.path, "providers.notion_main.token_env");
      return true;
    },
  );
});

test("fails clearly when a prompt asset path does not exist", () => {
  const fixture = createFixtureWorkspace();

  assert.throws(
    () =>
      parseConfig(
        VALID_CONFIG.replace(
          'base_system = "base/system.md"',
          'base_system = "base/missing-system.md"',
        ),
        {
          sourcePath: fixture.sourcePath,
          env: {},
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "missing_path");
      assert.equal(error.path, "prompt_packs.default.base_system");
      return true;
    },
  );
});

function createFixtureWorkspace(): { sourcePath: string; workspaceDir: string } {
  const workspaceDir = mkdtempSync(
    path.join(tmpdir(), "orqestrate-config-fixture-"),
  );

  writePromptFixtureFiles(path.join(workspaceDir, "prompts"));

  return {
    workspaceDir,
    sourcePath: path.join(workspaceDir, "config.toml"),
  };
}

function writePromptFixtureFiles(promptRoot: string): void {
  const files = {
    "base/system.md": "# Base System\n",
    "roles/design.md": "# Design\n",
    "roles/implement.md": "# Implement\n",
  };

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(promptRoot, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents, "utf8");
  }
}
