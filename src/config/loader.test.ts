import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
invariants = [
  "invariants/run-scope.md",
  "invariants/verification.md",
]

[prompt_capabilities."github.read_pr"]
authority = "execution_surface_read"
provider = "github"
surface = "pull_request"
effect = "read"
target_scope = "linked_pull_request"
allowed_phases = ["implement", "review"]
allowed_roles = ["implement", "review"]
required_context = ["pull_request_url"]

[prompt_capabilities.playwright_exploration]
authority = "behavioral"
allowed_phases = ["implement", "review"]

[prompt_packs.default]
base_system = "base/system.md"

[prompt_packs.default.roles]
design = "roles/design.md"
implement = "roles/implement.md"

[prompt_packs.default.phases]
review = "phases/review.md"

[prompt_packs.default.capabilities]
"github.read_pr" = "capabilities/github-read-pr.md"
playwright_exploration = "capabilities/playwright-exploration.md"

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
    configPath: path.join(REPO_ROOT, "config.example.toml"),
    env: {},
  });

  assert.equal(config.activeProfileName, "local");
  assert.equal(config.activeProfile.planningProvider.kind, "planning.local_files");
  assert.equal(config.activeProfile.contextProvider.kind, "context.local_files");
  const planningProvider = config.activeProfile.planningProvider;
  const contextProvider = config.activeProfile.contextProvider;

  if (planningProvider.kind !== "planning.local_files") {
    throw new Error("expected the docs example to use planning.local_files");
  }

  if (contextProvider.kind !== "context.local_files") {
    throw new Error("expected the docs example to use context.local_files");
  }

  assert.equal(
    config.paths.stateDir,
    path.join(REPO_ROOT, ".harness", "state"),
  );
  assert.equal(
    planningProvider.root,
    path.join(REPO_ROOT, ".harness", "local", "planning"),
  );
  assert.equal(
    contextProvider.root,
    path.join(REPO_ROOT, ".harness", "local", "context"),
  );
  assert.equal(
    contextProvider.templates.artifact_template,
    path.join(
      REPO_ROOT,
      "examples",
      "local",
      "context",
      "templates",
      "artifact.md",
    ),
  );
  assert.equal(
    contextProvider.templates.run_template,
    path.join(
      REPO_ROOT,
      "examples",
      "local",
      "context",
      "templates",
      "evidence.md",
    ),
  );
  assert.equal(
    config.activeProfile.promptPack.baseSystem,
    path.join(REPO_ROOT, "docs", "prompts", "base", "system.md"),
  );
  assert.equal(
    config.activeProfile.promptPack.phases.implement,
    path.join(REPO_ROOT, "docs", "prompts", "phases", "implement.md"),
  );
  assert.ok(config.prompts.invariants.length > 0);
  assert.equal(
    config.promptCapabilities["github.push_branch"].authority,
    "execution_surface_write",
  );
});

test("loads the docs example for the saas profile when required env vars exist", async () => {
  const config = await loadConfig({
    configPath: path.join(REPO_ROOT, "config.example.toml"),
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

test("copied example config resolves local roots inside the copied workspace", async () => {
  const workspaceDir = mkdtempSync(
    path.join(tmpdir(), "orqestrate-copied-config-fixture-"),
  );
  const configPath = path.join(workspaceDir, "config.toml");

  mkdirSync(path.join(workspaceDir, "docs"), { recursive: true });
  cpSync(
    path.join(REPO_ROOT, "docs", "prompts"),
    path.join(workspaceDir, "docs", "prompts"),
    { recursive: true },
  );
  writeFileSync(
    configPath,
    readFileSync(path.join(REPO_ROOT, "config.example.toml"), "utf8"),
    "utf8",
  );

  const config = await loadConfig({
    configPath,
    env: {},
  });
  const planningProvider = config.activeProfile.planningProvider;
  const contextProvider = config.activeProfile.contextProvider;

  if (planningProvider.kind !== "planning.local_files") {
    throw new Error("expected copied config to use planning.local_files");
  }

  if (contextProvider.kind !== "context.local_files") {
    throw new Error("expected copied config to use context.local_files");
  }

  assert.equal(config.paths.stateDir, path.join(workspaceDir, ".harness", "state"));
  assert.equal(
    planningProvider.root,
    path.join(workspaceDir, ".harness", "local", "planning"),
  );
  assert.equal(
    contextProvider.root,
    path.join(workspaceDir, ".harness", "local", "context"),
  );
  assert.equal(
    contextProvider.templates.artifact_template,
    path.join(
      workspaceDir,
      "examples",
      "local",
      "context",
      "templates",
      "artifact.md",
    ),
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
  assert.deepEqual(config.prompts.invariants, [
    path.join(fixture.workspaceDir, "prompts", "invariants", "run-scope.md"),
    path.join(fixture.workspaceDir, "prompts", "invariants", "verification.md"),
  ]);
  assert.equal(
    config.promptCapabilities["github.read_pr"].authority,
    "execution_surface_read",
  );
  assert.deepEqual(config.promptCapabilities["github.read_pr"].allowedPhases, [
    "implement",
    "review",
  ]);
  assert.deepEqual(config.promptCapabilities["github.read_pr"].allowedRoles, [
    "implement",
    "review",
  ]);
  assert.equal(
    config.promptPacks.default.overlays.organization.reviewer_qa,
    path.join(fixture.workspaceDir, "prompts", "overlays", "org", "reviewer-qa.md"),
  );
  assert.equal(
    config.promptPacks.default.experiments.reviewer_v2,
    path.join(fixture.workspaceDir, "prompts", "experiments", "reviewer-v2.md"),
  );
});

test("parses workspace setup scripts relative to the config location", () => {
  const fixture = createFixtureWorkspace();
  const config = parseConfig(
    `${VALID_CONFIG}

[workspace]
setup_script = "./scripts/bootstrap-worktree.sh"
`,
    {
      sourcePath: fixture.sourcePath,
      env: {},
    },
  );

  assert.equal(
    config.workspace.setupScript,
    path.join(fixture.workspaceDir, "scripts", "bootstrap-worktree.sh"),
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

test("parses GitHub execution-surface metadata for canonical capabilities", () => {
  const fixture = createFixtureWorkspace();
  const config = parseConfig(VALID_CONFIG, {
    sourcePath: fixture.sourcePath,
    env: {},
  });

  assert.equal(config.promptCapabilities["github.read_pr"].provider, "github");
  assert.equal(config.promptCapabilities["github.read_pr"].surface, "pull_request");
  assert.equal(config.promptCapabilities["github.read_pr"].effect, "read");
  assert.equal(
    config.promptCapabilities["github.read_pr"].targetScope,
    "linked_pull_request",
  );
});

test("accepts GitHub merge capabilities scoped to the merge phase", () => {
  const fixture = createFixtureWorkspace();
  const config = parseConfig(
    `${VALID_CONFIG}

[prompt_capabilities."github.merge_pr"]
authority = "execution_surface_write"
provider = "github"
surface = "merge"
effect = "state_transition"
target_scope = "linked_pull_request"
allowed_phases = ["merge"]
allowed_roles = ["merge"]
required_context = ["pull_request_url", "write_scope"]
`,
    {
      sourcePath: fixture.sourcePath,
      env: {},
    },
  );

  assert.equal(config.promptCapabilities["github.merge_pr"]?.surface, "merge");
  assert.deepEqual(config.promptCapabilities["github.merge_pr"]?.allowedPhases, [
    "merge",
  ]);
});

test("rejects GitHub capability metadata that violates role and phase policy", () => {
  const fixture = createFixtureWorkspace();

  assert.throws(
    () =>
      parseConfig(
        `${VALID_CONFIG}

[prompt_capabilities."github.write_review"]
authority = "execution_surface_write"
provider = "github"
surface = "review_submission"
effect = "write"
target_scope = "linked_pull_request"
allowed_phases = ["implement"]
allowed_roles = ["implement"]
required_context = ["pull_request_url", "write_scope"]
`,
        {
          sourcePath: fixture.sourcePath,
          env: {},
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "invalid_value");
      assert.equal(error.path, 'prompt_capabilities.github.write_review.allowed_phases');
      return true;
    },
  );
});

test("rejects GitHub capabilities that omit allowed phases", () => {
  const fixture = createFixtureWorkspace();

  assert.throws(
    () =>
      parseConfig(
        `${VALID_CONFIG}

[prompt_capabilities."github.reply_review_thread"]
authority = "execution_surface_write"
provider = "github"
surface = "review_thread"
effect = "write"
target_scope = "linked_pull_request"
allowed_roles = ["implement"]
required_context = ["pull_request_url", "write_scope"]
`,
        {
          sourcePath: fixture.sourcePath,
          env: {},
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "invalid_value");
      assert.equal(
        error.path,
        "prompt_capabilities.github.reply_review_thread.allowed_phases",
      );
      assert.match(error.message, /must declare at least one allowed phase/i);
      return true;
    },
  );
});

test("rejects GitHub pull-request read capabilities that are not scoped to the linked PR", () => {
  const fixture = createFixtureWorkspace();

  assert.throws(
    () =>
      parseConfig(
        VALID_CONFIG.replace(
          'target_scope = "linked_pull_request"',
          'target_scope = "assigned_branch"',
        ).replace(
          'required_context = ["pull_request_url"]',
          'required_context = ["assigned_branch"]',
        ),
        {
          sourcePath: fixture.sourcePath,
          env: {},
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "invalid_value");
      assert.equal(error.path, "prompt_capabilities.github.read_pr.target_scope");
      assert.match(error.message, /must target the linked pull request/i);
      return true;
    },
  );
});

test("loads the docs example default prompt pack with non-placeholder prompt assets", async () => {
  const config = await loadConfig({
    configPath: path.join(REPO_ROOT, "config.example.toml"),
    env: {},
  });
  const pack = config.promptPacks.default;
  const assetPaths = [
    pack.baseSystem,
    ...config.prompts.invariants,
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

test("rejects empty invariant prompt assets", () => {
  const fixture = createFixtureWorkspace();
  writeFileSync(
    path.join(fixture.workspaceDir, "prompts", "invariants", "run-scope.md"),
    "\n",
    "utf8",
  );

  assert.throws(
    () =>
      parseConfig(VALID_CONFIG, {
        sourcePath: fixture.sourcePath,
        env: {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "invalid_value");
      assert.equal(error.path, "prompts.invariants[0]");
      return true;
    },
  );
});

test("rejects configs that omit prompt invariants", () => {
  const fixture = createFixtureWorkspace();
  assert.throws(
    () =>
      parseConfig(
        VALID_CONFIG.replace(
          "invariants = [\n  \"invariants/run-scope.md\",\n  \"invariants/verification.md\",\n]\n\n",
          "",
        ),
        {
          sourcePath: fixture.sourcePath,
          env: {},
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "invalid_type");
      assert.equal(error.path, "prompts.invariants");
      return true;
    },
  );
});

test("rejects prompt packs that reference undefined prompt capabilities", () => {
  const fixture = createFixtureWorkspace();

  assert.throws(
    () =>
      parseConfig(
        VALID_CONFIG.replace(
          '"github.read_pr" = "capabilities/github-read-pr.md"',
          'missing_capability = "capabilities/github-read-pr.md"',
        ),
        {
          sourcePath: fixture.sourcePath,
          env: {},
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "invalid_value");
      assert.equal(
        error.path,
        "prompt_packs.default.capabilities.missing_capability",
      );
      return true;
    },
  );
});

test("rejects prompt packs whose capabilities omit required peer capabilities", () => {
  const fixture = createFixtureWorkspace();

  assert.throws(
    () =>
      parseConfig(
        VALID_CONFIG.replace(
          '[prompt_capabilities.playwright_exploration]\nauthority = "behavioral"\nallowed_phases = ["implement", "review"]\n',
          '[prompt_capabilities.playwright_exploration]\nauthority = "behavioral"\nallowed_phases = ["implement", "review"]\n\n[prompt_capabilities.cap_missing_peer]\nauthority = "behavioral"\nallowed_phases = ["review"]\n\n[prompt_capabilities.cap_requires_missing]\nauthority = "behavioral"\nallowed_phases = ["review"]\nrequires = ["cap_missing_peer"]\n',
        ).replace(
          'playwright_exploration = "capabilities/playwright-exploration.md"',
          'playwright_exploration = "capabilities/playwright-exploration.md"\ncap_requires_missing = "capabilities/github-read-pr.md"',
        ),
        {
          sourcePath: fixture.sourcePath,
          env: {},
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "invalid_value");
      assert.equal(
        error.path,
        "prompt_packs.default.capabilities.cap_requires_missing",
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
    "base/system.md": "# Base System\nStay focused on the assigned work item.\n",
    "invariants/run-scope.md":
      "# Run Scope\nOne run owns one work item and the assigned phase remains authoritative.\n",
    "invariants/verification.md":
      "# Verification\nRun required checks and report evidence honestly before claiming completion.\n",
    "roles/design.md": "# Design\nProduce a durable design artifact.\n",
    "roles/implement.md":
      "# Implement\nShip the smallest verified implementation that solves the issue.\n",
    "phases/review.md":
      "# Review Phase\nPrioritize correctness, regressions, and missing verification.\n",
    "capabilities/github-read-pr.md":
      "# GitHub Read PR\nInspect the pull request and relevant review feedback.\n",
    "capabilities/playwright-exploration.md":
      "# Browser Exploration\nUse browser evidence when a changed flow needs UI verification.\n",
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
