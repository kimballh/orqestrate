import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

[prompt_packs.default.phases]
review = "phases/review.md"

[prompt_packs.default.overlays.organization]
reviewer_qa = "overlays/org/reviewer-qa.md"

[prompt_packs.default.overlays.project]
reviewer_webapp = "overlays/project/reviewer-webapp.md"

[prompt_packs.default.experiments]
reviewer_v2 = "experiments/reviewer-v2.md"

[providers.linear_main]
kind = "planning.linear"
token_env = "LINEAR_API_KEY"
team = "ENG"
project = "Platform"

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

[profiles.saas.prompt]
organization_overlays = ["reviewer_qa"]
project_overlays = ["reviewer_webapp"]
default_experiment = "reviewer_v2"

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
  assert.equal(
    config.activeProfile.promptPack.phases.implement,
    path.join(REPO_ROOT, "docs", "prompts", "phases", "implement.md"),
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
  assert.equal(config.activeProfile.planningProvider.project, "Orqestrate Build");
  assert.equal(config.activeProfile.contextProvider.kind, "context.notion");
  assert.deepEqual(config.activeProfile.promptBehavior.organizationOverlayNames, [
    "reviewer_qa",
  ]);
  assert.deepEqual(config.activeProfile.promptBehavior.projectOverlayNames, [
    "reviewer_webapp",
  ]);
  assert.equal(
    config.activeProfile.promptBehavior.defaultExperimentName,
    "reviewer_v2",
  );
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
  assert.deepEqual(config.activeProfile.promptBehavior.organizationOverlayNames, []);
  assert.deepEqual(config.activeProfile.promptBehavior.projectOverlayNames, []);
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
  assert.equal(
    config.promptPacks.default.phases.review,
    path.join(fixture.workspaceDir, "prompts", "phases", "review.md"),
  );
  assert.equal(
    config.promptPacks.default.overlays.organization.reviewer_qa,
    path.join(fixture.workspaceDir, "prompts", "overlays", "org", "reviewer-qa.md"),
  );
  assert.equal(
    config.promptPacks.default.experiments.reviewer_v2,
    path.join(fixture.workspaceDir, "prompts", "experiments", "reviewer-v2.md"),
  );
});

test("parses optional Linear project selectors and status-name overrides", () => {
  const fixture = createFixtureWorkspace();
  const config = parseConfig(
    `${VALID_CONFIG}

[providers.linear_main.mapping]
implement_status = "Building"
review_status = "QA Review"
`,
    {
      sourcePath: fixture.sourcePath,
      activeProfile: "saas",
      env: {
        LINEAR_API_KEY: "linear-token",
        NOTION_TOKEN: "notion-token",
      },
    },
  );

  assert.equal(config.activeProfile.planningProvider.kind, "planning.linear");
  assert.equal(config.activeProfile.planningProvider.project, "Platform");
  assert.deepEqual(config.activeProfile.planningProvider.mapping, {
    implement_status: "Building",
    review_status: "QA Review",
  });
});

test("loads the docs example default prompt pack with non-placeholder prompt assets", async () => {
  const config = await loadConfig({
    configPath: path.join(REPO_ROOT, "docs/config.example.toml"),
    env: {},
  });
  const pack = config.promptPacks.default;
  const assetPaths = [
    pack.baseSystem,
    ...Object.values(pack.roles),
    ...Object.values(pack.phases),
    ...Object.values(pack.capabilities),
    ...Object.values(pack.overlays.organization),
    ...Object.values(pack.overlays.project),
    ...Object.values(pack.experiments),
  ];

  assert.deepEqual(Object.keys(pack.roles).sort(), [
    "design",
    "implement",
    "merge",
    "plan",
    "review",
  ]);
  assert.deepEqual(Object.keys(pack.phases).sort(), ["implement", "review"]);
  assert.equal(assetPaths.length, new Set(assetPaths).size);

  for (const assetPath of assetPaths) {
    const contents = readFileSync(assetPath, "utf8");
    assert.ok(contents.trim().length > 40, `${assetPath} should not be empty`);
    assert.doesNotMatch(
      contents,
      /placeholder/i,
      `${assetPath} should not contain placeholder text`,
    );
  }

  const roleContracts: Record<string, string[]> = {
    design: [
      "Return your result in this shape:",
      "STATUS: completed | failed | waiting_human",
      "SUMMARY:",
      "DETAILS:",
      "ARTIFACT: markdown design note",
      "REQUESTED_HUMAN_INPUT: optional blocking question",
    ],
    plan: [
      "Return your result in this shape:",
      "STATUS: completed | failed | waiting_human",
      "SUMMARY:",
      "DETAILS:",
      "ARTIFACT: markdown implementation plan",
      "REQUESTED_HUMAN_INPUT: optional blocking question",
    ],
    implement: [
      "Return your result in this shape:",
      "STATUS: completed | failed | waiting_human",
      "SUMMARY:",
      "DETAILS:",
      "VERIFICATION:",
      "ARTIFACT:",
      "REQUESTED_HUMAN_INPUT: optional blocking question",
    ],
    review: [
      "Return your result in this shape:",
      "STATUS: completed | failed | waiting_human",
      "SUMMARY:",
      "DETAILS:",
      "ARTIFACT: markdown review report",
      "REQUESTED_HUMAN_INPUT: optional blocking question",
    ],
    merge: [
      "Return your result in this shape:",
      "STATUS: completed | failed | waiting_human",
      "SUMMARY:",
      "DETAILS:",
      "ARTIFACT: markdown merge summary",
      "REQUESTED_HUMAN_INPUT: optional blocking question",
    ],
  };

  for (const [role, markers] of Object.entries(roleContracts)) {
    const contents = readFileSync(pack.roles[role], "utf8");

    for (const marker of markers) {
      assert.match(
        contents,
        new RegExp(escapeRegExp(marker)),
        `${role} role prompt should include '${marker}'`,
      );
    }
  }
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

test("resolves profile-owned prompt behavior from the selected prompt pack", () => {
  const fixture = createFixtureWorkspace();
  const config = parseConfig(VALID_CONFIG, {
    sourcePath: fixture.sourcePath,
    activeProfile: "saas",
    env: {
      LINEAR_API_KEY: "linear-token",
      NOTION_TOKEN: "notion-token",
    },
  });

  assert.deepEqual(config.activeProfile.promptBehavior.organizationOverlayNames, [
    "reviewer_qa",
  ]);
  assert.deepEqual(config.activeProfile.promptBehavior.projectOverlayNames, [
    "reviewer_webapp",
  ]);
  assert.deepEqual(config.activeProfile.promptBehavior.organizationOverlays, [
    {
      name: "reviewer_qa",
      assetPath: path.join(
        fixture.workspaceDir,
        "prompts",
        "overlays",
        "org",
        "reviewer-qa.md",
      ),
    },
  ]);
  assert.deepEqual(config.activeProfile.promptBehavior.projectOverlays, [
    {
      name: "reviewer_webapp",
      assetPath: path.join(
        fixture.workspaceDir,
        "prompts",
        "overlays",
        "project",
        "reviewer-webapp.md",
      ),
    },
  ]);
  assert.equal(
    config.activeProfile.promptBehavior.defaultExperimentAssetPath,
    path.join(fixture.workspaceDir, "prompts", "experiments", "reviewer-v2.md"),
  );
});

test("rejects unknown profile organization overlays", () => {
  const fixture = createFixtureWorkspace();
  assert.throws(
    () =>
      parseConfig(
        VALID_CONFIG.replace(
          'organization_overlays = ["reviewer_qa"]',
          'organization_overlays = ["missing_overlay"]',
        ),
        {
          sourcePath: fixture.sourcePath,
          activeProfile: "saas",
          env: {
            LINEAR_API_KEY: "linear-token",
            NOTION_TOKEN: "notion-token",
          },
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "invalid_value");
      assert.equal(error.path, "profiles.saas.prompt.organization_overlays");
      assert.match(error.message, /Unknown organization overlay 'missing_overlay'/);
      return true;
    },
  );
});

test("rejects prompt overlay group mismatches", () => {
  const fixture = createFixtureWorkspace();
  assert.throws(
    () =>
      parseConfig(
        VALID_CONFIG.replace(
          'organization_overlays = ["reviewer_qa"]',
          'organization_overlays = ["reviewer_webapp"]',
        ),
        {
          sourcePath: fixture.sourcePath,
          activeProfile: "saas",
          env: {
            LINEAR_API_KEY: "linear-token",
            NOTION_TOKEN: "notion-token",
          },
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "invalid_value");
      assert.equal(error.path, "profiles.saas.prompt.organization_overlays");
      assert.match(
        error.message,
        /configured as a project overlay, not an organization overlay/,
      );
      return true;
    },
  );
});

test("rejects reverse-direction prompt overlay group mismatches on the project field", () => {
  const fixture = createFixtureWorkspace();
  assert.throws(
    () =>
      parseConfig(
        VALID_CONFIG.replace(
          'project_overlays = ["reviewer_webapp"]',
          'project_overlays = ["reviewer_qa"]',
        ),
        {
          sourcePath: fixture.sourcePath,
          activeProfile: "saas",
          env: {
            LINEAR_API_KEY: "linear-token",
            NOTION_TOKEN: "notion-token",
          },
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "invalid_value");
      assert.equal(error.path, "profiles.saas.prompt.project_overlays");
      assert.match(
        error.message,
        /configured as an organization overlay, not a project overlay/,
      );
      return true;
    },
  );
});

test("rejects unknown default prompt experiments", () => {
  const fixture = createFixtureWorkspace();
  assert.throws(
    () =>
      parseConfig(
        VALID_CONFIG.replace(
          'default_experiment = "reviewer_v2"',
          'default_experiment = "missing_experiment"',
        ),
        {
          sourcePath: fixture.sourcePath,
          activeProfile: "saas",
          env: {
            LINEAR_API_KEY: "linear-token",
            NOTION_TOKEN: "notion-token",
          },
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "invalid_value");
      assert.equal(error.path, "profiles.saas.prompt.default_experiment");
      assert.match(
        error.message,
        /Unknown default prompt experiment 'missing_experiment' configured\./,
      );
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
    "phases/review.md": "# Review Phase\n",
    "overlays/org/reviewer-qa.md": "# Reviewer QA\n",
    "overlays/project/reviewer-webapp.md": "# Reviewer Webapp\n",
    "experiments/reviewer-v2.md": "# Reviewer V2\n",
  };

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(promptRoot, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents, "utf8");
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
