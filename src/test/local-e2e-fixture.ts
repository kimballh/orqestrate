import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

import { loadConfig } from "../config/loader.js";
import type { LoadedConfig } from "../config/types.js";
import type { WorkItemRecord } from "../domain-model.js";

export type LocalFilesE2eFixture = {
  workspaceDir: string;
  configPath: string;
  planningRoot: string;
  contextRoot: string;
  loadedConfig: LoadedConfig;
  workItem: WorkItemRecord;
};

export async function createLocalFilesE2eFixture(
  t: TestContext,
): Promise<LocalFilesE2eFixture> {
  const workspaceDir = mkdtempSync(path.join(tmpdir(), "orq-local-e2e-"));
  t.after(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  const promptRoot = path.join(workspaceDir, "prompts");
  const planningRoot = path.join(workspaceDir, ".planning");
  const contextRoot = path.join(workspaceDir, ".context");
  const configPath = path.join(workspaceDir, "config.toml");
  const workItem = createWorkItemRecord();

  writePromptFixtureFiles(promptRoot);
  seedPlanningIssues(planningRoot, [workItem]);
  writeFileSync(configPath, renderConfigToml(), "utf8");

  const loadedConfig = await loadConfig({
    configPath,
    cwd: workspaceDir,
  });

  return {
    workspaceDir,
    configPath,
    planningRoot,
    contextRoot,
    loadedConfig,
    workItem,
  };
}

function seedPlanningIssues(root: string, records: WorkItemRecord[]): void {
  const issuesDir = path.join(root, "issues");
  mkdirSync(issuesDir, { recursive: true });

  for (const record of records) {
    writeFileSync(
      path.join(issuesDir, `${record.id}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
  }
}

function createWorkItemRecord(): WorkItemRecord {
  return {
    id: "ORQ-49",
    identifier: "ORQ-49",
    title:
      "Build end-to-end fixture suite for local_files planning and context profile",
    description:
      "Validate the full core loop with local planning and context providers only.",
    status: "implement",
    phase: "implement",
    priority: 2,
    labels: ["fixtures", "local-files"],
    url: "https://linear.app/orqestrate/issue/ORQ-49",
    parentId: "ORQ-15",
    dependencyIds: ["ORQ-25", "ORQ-38"],
    blockedByIds: [],
    blocksIds: ["ORQ-52"],
    artifactUrl: null,
    updatedAt: "2026-04-15T16:00:00.000Z",
    createdAt: "2026-04-13T23:56:29.617Z",
    orchestration: {
      state: "queued",
      owner: null,
      runId: null,
      leaseUntil: null,
      reviewOutcome: "none",
      blockedReason: null,
      lastError: null,
      attemptCount: 0,
    },
  };
}

function renderConfigToml(): string {
  return `version = 1
active_profile = "local"

[paths]
state_dir = ".state"
data_dir = ".data"
log_dir = ".logs"

[policy]
max_concurrent_runs = 2
max_runs_per_provider = 1
allow_mixed_providers = true
default_phase_timeout_sec = 5400

[prompts]
root = "./prompts"
active_pack = "default"
invariants = [
  "invariants/run-scope.md",
  "invariants/authority-boundaries.md",
  "invariants/verification.md",
  "invariants/blockers.md",
]

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

[providers.local_planning]
kind = "planning.local_files"
root = ".planning"

[providers.local_context]
kind = "context.local_files"
root = ".context"

[profiles.local]
planning = "local_planning"
context = "local_context"
prompt_pack = "default"
`;
}

function writePromptFixtureFiles(promptRoot: string): void {
  const files = {
    "base/system.md":
      "# Base System\nStay focused on the assigned work item and report concrete evidence.\n",
    "invariants/run-scope.md":
      "# Run Scope\nOne run owns one work item and the assigned phase remains authoritative.\n",
    "invariants/authority-boundaries.md":
      "# Authority Boundaries\nDo not invent workflow transitions outside the assigned phase.\n",
    "invariants/verification.md":
      "# Verification\nRun real checks and name any remaining gaps honestly.\n",
    "invariants/blockers.md":
      "# Blockers\nEscalate the smallest concrete blocker when a human decision is required.\n",
    "roles/design.md": "# Design\nProduce a durable design artifact.\n",
    "roles/plan.md": "# Plan\nProduce an implementation plan.\n",
    "roles/implement.md":
      "# Implement\nShip the smallest verified implementation that closes the assigned gap.\n",
    "roles/review.md":
      "# Review\nPrioritize correctness, regressions, and verification gaps.\n",
    "roles/merge.md": "# Merge\nFinalize a completed change for merge.\n",
    "phases/implement.md":
      "# Implement Phase\nWrite code, run checks, and record the outcome.\n",
    "phases/review.md":
      "# Review Phase\nCall out findings and missing verification clearly.\n",
  };

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(promptRoot, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents, "utf8");
  }
}
