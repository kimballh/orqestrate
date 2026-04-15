import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../index.js";

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

function createPromptCliFixture(): {
  workspaceDir: string;
  configPath: string;
} {
  const workspaceDir = mkdtempSync(path.join(tmpdir(), "orq-prompt-cli-"));
  const promptRoot = path.join(workspaceDir, "prompts");

  mkdirSync(path.join(workspaceDir, ".harness", "planning"), { recursive: true });
  mkdirSync(path.join(workspaceDir, ".harness", "context"), { recursive: true });

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

  const configPath = path.join(workspaceDir, "config.toml");
  writeFileSync(
    configPath,
    `version = 1
active_profile = "local"

[paths]
state_dir = ".harness/state"
data_dir = ".harness/data"
log_dir = ".harness/logs"

[prompts]
root = "./prompts"
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
root = ".harness/planning"

[providers.local_context]
kind = "context.local_files"
root = ".harness/context"

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
