import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../config/loader.js";
import { isDirectExecution, runCli } from "../index.js";
import { renderPromptPreview } from "./prompt-preview.js";
import { openRuntimeDatabase } from "../runtime/persistence/database.js";
import { RuntimeRepository } from "../runtime/persistence/runtime-repository.js";

test("prompt render uses profile defaults and synthetic preview context", async () => {
  const fixture = createPromptCliFixture();
  const result = await invokeCli(
    [
      "prompt",
      "render",
      "--config",
      fixture.configPath,
      "--role",
      "review",
      "--phase",
      "review",
    ],
    fixture.workspaceDir,
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^Selection$/m);
  assert.match(result.stdout, /Prompt pack: default/);
  assert.match(result.stdout, /Organization overlays: default_org/);
  assert.match(result.stdout, /Project overlays: default_project/);
  assert.match(result.stdout, /Experiment: reviewer_v2/);
  assert.match(result.stdout, /Context source: synthetic preview defaults/);
  assert.match(result.stdout, /Work item ID: prompt-preview/);
});

test("prompt render supports preview-only overrides and JSON output", async () => {
  const fixture = createPromptCliFixture();
  const contextFilePath = path.join(fixture.workspaceDir, "preview-context.json");
  writeFileSync(
    contextFilePath,
    JSON.stringify(
      {
        runId: "preview-run",
        workItem: {
          identifier: "ORQ-45",
          title: "Implement prompt render and diff CLI",
        },
        workspace: {
          pullRequestUrl: "https://github.com/kimballh/orqestrate/pull/45",
        },
        expectations: {
          requiredRepoChecks: ["npm run check"],
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const result = await invokeCli(
    [
      "prompt",
      "render",
      "--config",
      fixture.configPath,
      "--role",
      "review",
      "--phase",
      "review",
      "--organization-overlay",
      "alt_org",
      "--project-overlay",
      "alt_project",
      "--capability",
      "github_review",
      "--no-experiment",
      "--context-file",
      contextFilePath,
      "--format",
      "json",
    ],
    fixture.workspaceDir,
  );

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.contextSource, "context_file");
  assert.equal(parsed.selection.profileName, "local");
  assert.deepEqual(parsed.selection.organizationOverlays, ["alt_org"]);
  assert.deepEqual(parsed.selection.projectOverlays, ["alt_project"]);
  assert.deepEqual(parsed.selection.capabilities, ["github_review"]);
  assert.equal(parsed.selection.experiment, null);
  assert.equal(parsed.context.runId, "preview-run");
  assert.equal(parsed.context.workItem.identifier, "ORQ-45");
  assert.match(parsed.prompt.userPrompt, /Authorized capabilities: github_review/);
});

test("prompt render anchors synthetic preview context to the selected config location", async () => {
  const fixture = createPromptCliFixture();
  const outsideDir = mkdtempSync(path.join(tmpdir(), "orq-prompt-cli-outside-"));
  const result = await invokeCli(
    [
      "prompt",
      "render",
      "--config",
      fixture.configPath,
      "--role",
      "review",
      "--phase",
      "review",
      "--format",
      "json",
    ],
    outsideDir,
  );

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.context.workspace.repoRoot, fixture.workspaceDir);
  assert.equal(parsed.context.workspace.workingDir, fixture.workspaceDir);
});

test("prompt render uses the repo root when the config lives in a nested directory", async () => {
  const fixture = createPromptCliFixture({ configSubdir: "docs" });
  const outsideDir = mkdtempSync(path.join(tmpdir(), "orq-prompt-cli-outside-"));
  const result = await invokeCli(
    [
      "prompt",
      "render",
      "--config",
      fixture.configPath,
      "--role",
      "review",
      "--phase",
      "review",
      "--format",
      "json",
    ],
    outsideDir,
  );

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.context.workspace.repoRoot, fixture.workspaceDir);
  assert.equal(parsed.context.workspace.workingDir, fixture.workspaceDir);
});

test("prompt render reads workspace-local prompt overrides from the workspace root for nested configs", async () => {
  const fixture = createPromptCliFixture({ configSubdir: "ops" });
  const overridePath = path.join(
    fixture.workspaceDir,
    ".orqestrate",
    "prompts",
    "roles",
    "review.md",
  );

  mkdirSync(path.dirname(overridePath), { recursive: true });
  writeFileSync(overridePath, "Workspace review override.\n", "utf8");

  const result = await invokeCli(
    [
      "prompt",
      "render",
      "--config",
      fixture.configPath,
      "--role",
      "review",
      "--phase",
      "review",
      "--format",
      "json",
    ],
    fixture.workspaceDir,
  );

  const parsed = JSON.parse(result.stdout);
  assert.equal(
    parsed.selection.profileName,
    "local",
  );
  assert.equal(
    parsed.resolvedLayers.some(
      (layer: { ref: string }) =>
        layer.ref === "workspace-prompt:replace/roles/review.md",
    ),
    true,
  );
  assert.match(parsed.prompt.userPrompt, /Workspace review override\./);
  assert.doesNotMatch(parsed.prompt.userPrompt, /Review role instructions\./);
});

test("prompt diff reports source and prompt changes for variant overrides", async () => {
  const fixture = createPromptCliFixture();
  const result = await invokeCli(
    [
      "prompt",
      "diff",
      "--config",
      fixture.configPath,
      "--role",
      "review",
      "--phase",
      "review",
      "--variant-no-experiment",
    ],
    fixture.workspaceDir,
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^Source Changes$/m);
  assert.match(
    result.stdout,
    /REMOVED \[experiment\] prompt-pack:default\/experiments\/reviewer-v2\.md/,
  );
  assert.match(result.stdout, /^System Prompt Diff$/m);
  assert.match(result.stdout, /No changes in systemPrompt\./);
  assert.match(result.stdout, /^User Prompt Diff$/m);
  assert.match(result.stdout, /--- left\/userPrompt/);
});

test("prompt replay compares a stored run against a variant experiment", async () => {
  const fixture = createPromptCliFixture();
  const seeded = await seedReplayRun(fixture, {
    runId: "run-replay-001",
  });
  const result = await invokeCli(
    [
      "prompt",
      "replay",
      "--config",
      fixture.configPath,
      "--run-id",
      seeded.runId,
      "--variant-experiment",
      "reviewer_alt",
    ],
    fixture.workspaceDir,
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^Historical Run$/m);
  assert.match(result.stdout, /Replay context: stored snapshot \(lossless\)/);
  assert.match(
    result.stdout,
    /REMOVED \[experiment\] prompt-pack:default\/experiments\/reviewer-v2\.md/,
  );
  assert.match(
    result.stdout,
    /ADDED \[experiment\] prompt-pack:default\/experiments\/reviewer-alt\.md/,
  );
  assert.match(result.stdout, /^User Prompt Diff$/m);
});

test("prompt replay emits JSON and reports legacy reconstruction for older runs", async () => {
  const fixture = createPromptCliFixture();
  const seeded = await seedReplayRun(fixture, {
    runId: "run-replay-legacy",
    legacy: true,
  });
  const result = await invokeCli(
    [
      "prompt",
      "replay",
      "--config",
      fixture.configPath,
      "--run-id",
      seeded.runId,
      "--format",
      "json",
    ],
    fixture.workspaceDir,
  );

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.replayContextSource, "legacy_reconstruction");
  assert.equal(parsed.replayFidelity, "partial");
  assert.equal(parsed.current.contextSource, "legacy_reconstruction");
  assert.equal(parsed.replayContext.workItem.identifier, "ORQ-47");
  assert.equal(parsed.replayContext.workItem.title, "Review prompt drift");
});

test("prompt replay keeps historical lookup on the base profile when variant-profile differs", async () => {
  const fixture = createPromptCliFixture();
  const baseConfig = await loadConfig({
    configPath: fixture.configPath,
    cwd: fixture.workspaceDir,
  });
  const variantConfig = {
    ...structuredClone(baseConfig),
    paths: {
      ...baseConfig.paths,
      stateDir: path.join(fixture.workspaceDir, ".harness", "variant-state"),
      logDir: path.join(fixture.workspaceDir, ".harness", "variant-logs"),
    },
    activeProfileName: "variant",
    activeProfile: {
      ...structuredClone(baseConfig.activeProfile),
      name: "variant",
    },
    profiles: {
      ...structuredClone(baseConfig.profiles),
      variant: {
        ...structuredClone(baseConfig.activeProfile),
        name: "variant",
      },
    },
  };
  await seedReplayRunForConfig(baseConfig, fixture.workspaceDir, {
    runId: "run-replay-cross-profile",
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(
    [
      "prompt",
      "replay",
      "--config",
      fixture.configPath,
      "--profile",
      "local",
      "--variant-profile",
      "variant",
      "--run-id",
      "run-replay-cross-profile",
      "--format",
      "json",
    ],
    {
      cwd: () => fixture.workspaceDir,
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      loadConfig: async (options) =>
        options?.activeProfile === "variant" ? variantConfig : baseConfig,
    },
  );

  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout.join("\n"));
  assert.equal(parsed.historicalRun.runId, "run-replay-cross-profile");
  assert.equal(parsed.current.selection.profileName, "variant");
  assert.equal(
    parsed.historicalRun.databasePath,
    path.join(baseConfig.paths.stateDir, "runtime.sqlite"),
  );
});

test("prompt subcommand help exits successfully", async () => {
  const fixture = createPromptCliFixture();
  const renderHelp = await invokeCli(
    ["prompt", "render", "--help"],
    fixture.workspaceDir,
  );
  const diffHelp = await invokeCli(
    ["prompt", "diff", "--help"],
    fixture.workspaceDir,
  );
  const replayHelp = await invokeCli(
    ["prompt", "replay", "--help"],
    fixture.workspaceDir,
  );

  assert.equal(renderHelp.exitCode, 0);
  assert.match(renderHelp.stdout, /^Render options:$/m);
  assert.equal(diffHelp.exitCode, 0);
  assert.match(diffHelp.stdout, /^Diff options:$/m);
  assert.equal(replayHelp.exitCode, 0);
  assert.match(replayHelp.stdout, /^Replay options:$/m);
});

test("prompt render does not treat an option value named help as a help request", async () => {
  const fixture = createPromptCliFixture();
  const helpNamedContextPath = path.join(fixture.workspaceDir, "help");
  writeFileSync(
    helpNamedContextPath,
    JSON.stringify(
      {
        workItem: {
          identifier: "ORQ-45",
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const result = await invokeCli(
    [
      "prompt",
      "render",
      "--config",
      fixture.configPath,
      "--role",
      "review",
      "--phase",
      "review",
      "--context-file",
      "help",
      "--format",
      "json",
    ],
    fixture.workspaceDir,
  );

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.contextSource, "context_file");
  assert.equal(parsed.context.workItem.identifier, "ORQ-45");
});

test("prompt render fails clearly for invalid context files", async () => {
  const fixture = createPromptCliFixture();
  const invalidContextPath = path.join(fixture.workspaceDir, "invalid-context.json");
  writeFileSync(invalidContextPath, JSON.stringify({ unknownField: true }), "utf8");

  await assert.rejects(
    () =>
      runCli(
        [
          "prompt",
          "render",
          "--config",
          fixture.configPath,
          "--role",
          "review",
          "--phase",
          "review",
          "--context-file",
          invalidContextPath,
        ],
        {
          cwd: () => fixture.workspaceDir,
          stdout: () => undefined,
          stderr: () => undefined,
        },
      ),
    /contains an unknown field 'unknownField'/,
  );
});

test("direct execution detection compares real paths instead of raw argv strings", () => {
  const symlinkedEntry = "/tmp/orq/dist/index.js";
  const canonicalEntry = "/private/tmp/orq/dist/index.js";
  const moduleUrl = `file://${canonicalEntry}`;
  const resolved = new Map<string, string>([
    [symlinkedEntry, canonicalEntry],
    [canonicalEntry, canonicalEntry],
  ]);

  assert.equal(
    isDirectExecution(
      symlinkedEntry,
      moduleUrl,
      (targetPath) => resolved.get(targetPath) ?? targetPath,
    ),
    true,
  );
});

async function invokeCli(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(args, {
    cwd: () => cwd,
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  });

  return {
    exitCode,
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
  };
}

function createPromptCliFixture(options: { configSubdir?: string } = {}): {
  workspaceDir: string;
  configPath: string;
} {
  const workspaceDir = mkdtempSync(path.join(tmpdir(), "orq-prompt-cli-"));
  const promptRoot = path.join(workspaceDir, "prompts");
  const configDir = path.join(workspaceDir, options.configSubdir ?? "");
  const workspaceRelativeToConfig = toPosixPath(
    path.relative(configDir, workspaceDir) || ".",
  );

  mkdirSync(path.join(workspaceDir, ".harness", "planning"), { recursive: true });
  mkdirSync(path.join(workspaceDir, ".harness", "context"), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(workspaceDir, "package.json"),
    JSON.stringify({ name: "prompt-cli-fixture", private: true }, null, 2),
    "utf8",
  );

  const promptFiles = new Map<string, string>([
    ["base/system.md", "Base system prompt for prompt CLI tests.\n"],
    ["invariants/run-scope.md", "Stay inside the assigned work item.\n"],
    ["roles/design.md", "Design role instructions.\n"],
    ["roles/plan.md", "Plan role instructions.\n"],
    ["roles/implement.md", "Implement role instructions.\n"],
    ["roles/review.md", "Review role instructions.\n"],
    ["roles/merge.md", "Merge role instructions.\n"],
    ["phases/implement.md", "Implementation phase instructions.\n"],
    ["phases/review.md", "Review phase instructions.\n"],
    ["capabilities/github-review.md", "GitHub review capability instructions.\n"],
    ["overlays/org/default-org.md", "Default organization overlay.\n"],
    ["overlays/org/alt-org.md", "Alternate organization overlay.\n"],
    ["overlays/project/default-project.md", "Default project overlay.\n"],
    ["overlays/project/alt-project.md", "Alternate project overlay.\n"],
    ["experiments/reviewer-v2.md", "Experiment reviewer v2.\n"],
    ["experiments/reviewer-alt.md", "Alternate reviewer experiment.\n"],
  ]);

  for (const [relativePath, contents] of promptFiles) {
    const absolutePath = path.join(promptRoot, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents, "utf8");
  }

  const configPath = path.join(configDir, "config.toml");
  writeFileSync(
    configPath,
    `version = 1
active_profile = "local"

[paths]
state_dir = "${workspaceRelativeToConfig}/.harness/state"
data_dir = "${workspaceRelativeToConfig}/.harness/data"
log_dir = "${workspaceRelativeToConfig}/.harness/logs"

[prompts]
root = "${workspaceRelativeToConfig}/prompts"
active_pack = "default"
invariants = ["invariants/run-scope.md"]

[prompt_capabilities.github_review]
authority = "execution_surface_read"
allowed_phases = ["review"]
required_context = ["pull_request_url"]

[prompt_packs.default]
base_system = "base/system.md"

[prompt_packs.default.roles]
design = "roles/design.md"
plan = "roles/plan.md"
implement = "roles/implement.md"
review = "roles/review.md"
merge = "roles/merge.md"

[prompt_packs.default.phases]
implement = "phases/implement.md"
review = "phases/review.md"

[prompt_packs.default.capabilities]
github_review = "capabilities/github-review.md"

[prompt_packs.default.overlays.organization]
default_org = "overlays/org/default-org.md"
alt_org = "overlays/org/alt-org.md"

[prompt_packs.default.overlays.project]
default_project = "overlays/project/default-project.md"
alt_project = "overlays/project/alt-project.md"

[prompt_packs.default.experiments]
reviewer_v2 = "experiments/reviewer-v2.md"
reviewer_alt = "experiments/reviewer-alt.md"

[providers.local_planning]
kind = "planning.local_files"
root = "${workspaceRelativeToConfig}/.harness/planning"

[providers.local_context]
kind = "context.local_files"
root = "${workspaceRelativeToConfig}/.harness/context"

[profiles.local]
planning = "local_planning"
context = "local_context"
prompt_pack = "default"

[profiles.local.prompt]
organization_overlays = ["default_org"]
project_overlays = ["default_project"]
default_experiment = "reviewer_v2"
`,
    "utf8",
  );

  return {
    workspaceDir,
    configPath,
  };
}

async function seedReplayRun(
  fixture: { workspaceDir: string; configPath: string },
  options: {
    runId: string;
    legacy?: boolean;
  },
): Promise<{ runId: string }> {
  const config = await loadConfig({
    configPath: fixture.configPath,
    cwd: fixture.workspaceDir,
  });
  await seedReplayRunForConfig(config, fixture.workspaceDir, options);

  return {
    runId: options.runId,
  };
}

async function seedReplayRunForConfig(
  config: Awaited<ReturnType<typeof loadConfig>>,
  workspaceDir: string,
  options: {
    runId: string;
    legacy?: boolean;
  },
): Promise<void> {
  const replayContext = {
    runId: options.runId,
    workItem: {
      id: "issue-47",
      identifier: "ORQ-47",
      title: "Review prompt drift",
      description: "Compare prompt experiments against a captured historical run.",
      labels: ["prompts", "diagnostics"],
      url: "https://linear.app/orqestrate/issue/ORQ-47",
    },
    artifact: {
      artifactId: "artifact-47",
      url: "https://www.notion.so/orq-47",
      summary: "Replay artifact summary",
    },
    workspace: {
      repoRoot: workspaceDir,
      workingDir: workspaceDir,
      mode: "shared_readonly" as const,
      assignedBranch: "hillkimball/orq-47",
      baseBranch: "main",
      pullRequestUrl: "https://github.com/kimballh/orqestrate/pull/47",
      pullRequestMode: "draft",
      writeScope: "repo",
    },
    expectations: {
      expectedOutputs: ["document prompt drift"],
      verificationRequired: true,
      requiredRepoChecks: ["npm run check"],
      testExpectations: "Add replay coverage.",
    },
    operatorNote: "Keep the replay focused on prompt diagnostics.",
    additionalContext: "Historical replay fixture for prompt CLI tests.",
    attachments: [
      {
        kind: "text" as const,
        value: "Captured from a prior ORQ-47 rehearsal.",
        label: "Fixture note",
      },
    ],
  };
  const preview = await renderPromptPreview(config, {
    role: "review",
    phase: "review",
    context: replayContext,
    cwd: workspaceDir,
    configSourcePath: config.sourcePath,
  });
  const database = openRuntimeDatabase(
    path.join(config.paths.stateDir, "runtime.sqlite"),
  );

  try {
    const repository = new RuntimeRepository(database.connection);
    repository.enqueueRun({
      runId: options.runId,
      phase: "review",
      workItem: replayContext.workItem,
      artifact: replayContext.artifact,
      provider: "codex",
      workspace: {
        repoRoot: replayContext.workspace.repoRoot,
        mode: replayContext.workspace.mode,
        workingDirHint: replayContext.workspace.workingDir,
        baseRef: replayContext.workspace.baseBranch,
        assignedBranch: replayContext.workspace.assignedBranch,
        pullRequestUrl: replayContext.workspace.pullRequestUrl,
        pullRequestMode: replayContext.workspace.pullRequestMode,
        writeScope: replayContext.workspace.writeScope,
      },
      prompt: preview.prompt,
      grantedCapabilities: preview.selection.capabilities,
      promptProvenance: {
        selection: {
          promptPackName: preview.selection.promptPackName,
          capabilityNames: preview.selection.capabilities,
          organizationOverlayNames: preview.selection.organizationOverlays,
          projectOverlayNames: preview.selection.projectOverlays,
          experimentName: preview.selection.experiment,
        },
        sources: preview.resolvedLayers.map((layer) => ({
          kind: layer.kind,
          ref: layer.ref,
          digest: layer.digest,
        })),
        rendered: {
          systemPromptLength: preview.prompt.systemPrompt?.length ?? 0,
          userPromptLength: preview.prompt.userPrompt.length,
          attachmentKinds: preview.prompt.attachments.map((attachment) => attachment.kind),
          attachmentCount: preview.prompt.attachments.length,
        },
      },
      promptReplayContext: options.legacy === true ? null : replayContext,
      limits: {
        maxWallTimeSec: 5400,
        idleTimeoutSec: 300,
        bootstrapTimeoutSec: 120,
      },
      requestedBy: "Kimball Hill",
    });
  } finally {
    database.close();
  }
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}
