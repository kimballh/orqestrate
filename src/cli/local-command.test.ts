import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runCli } from "../index.js";
import { loadConfig } from "../config/loader.js";
import { LocalFilesPlanningBackend } from "../providers/planning/local-files-backend.js";
import type { ExecuteClaimedRunResult } from "../orchestrator/execute-run.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

test("top-level help includes the local command", async () => {
  const fixture = createLocalCliFixture();
  const result = await invokeCli(["--help"], fixture.workspaceDir);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /local\s+Manage planning\.local_files work items\./);
});

test("local add-issue creates a new issue file and keeps the index in sync", async () => {
  const fixture = createLocalCliFixture();
  await bootstrapLocalFixture(fixture.workspaceDir);

  const result = await invokeCli(
    [
      "local",
      "add-issue",
      "--title",
      "Add a local issue creation CLI",
      "--status",
      "implement",
      "--priority",
      "2",
      "--label",
      "cli",
      "--label",
      "local-first",
    ],
    fixture.workspaceDir,
  );

  const issuePath = path.join(
    fixture.workspaceDir,
    ".harness",
    "local",
    "planning",
    "issues",
    "LOCAL-004.json",
  );
  const indexPath = path.join(
    fixture.workspaceDir,
    ".harness",
    "local",
    "planning",
    "index.json",
  );
  const createdIssue = JSON.parse(readFileSync(issuePath, "utf8"));
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const config = await loadConfig({
    configPath: path.join(fixture.workspaceDir, "config.toml"),
    env: {},
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Local issue created\./);
  assert.equal(existsSync(issuePath), true);
  assert.equal(createdIssue.id, "LOCAL-004");
  assert.equal(createdIssue.identifier, "LOCAL-004");
  assert.equal(createdIssue.status, "implement");
  assert.equal(createdIssue.phase, "implement");
  assert.equal(createdIssue.orchestration.state, "queued");
  assert.deepEqual(createdIssue.labels, ["cli", "local-first"]);
  assert.equal(
    index.items.some((item: { id: string }) => item.id === "LOCAL-004"),
    true,
  );

  if (config.activeProfile.planningProvider.kind !== "planning.local_files") {
    throw new Error("expected the local fixture to use planning.local_files");
  }

  const backend = new LocalFilesPlanningBackend(config.activeProfile.planningProvider);
  await backend.validateConfig();
});

test("local add-issue rejects non-local planning profiles", async () => {
  const fixture = createLocalCliFixture();
  await bootstrapLocalFixture(fixture.workspaceDir);

  const previousToken = process.env.LINEAR_API_KEY;
  const previousSecret = process.env.LINEAR_WEBHOOK_SECRET;
  process.env.LINEAR_API_KEY = "test-linear-token";
  process.env.LINEAR_WEBHOOK_SECRET = "test-linear-secret";

  try {
    await assert.rejects(
      () =>
        runCli(
          [
            "local",
            "add-issue",
            "--profile",
            "hybrid",
            "--title",
            "Should not write through the Linear profile",
          ],
          {
            cwd: () => fixture.workspaceDir,
            stdout: () => undefined,
            stderr: () => undefined,
          },
        ),
      /requires planning\.local_files/i,
    );
  } finally {
    if (previousToken === undefined) {
      delete process.env.LINEAR_API_KEY;
    } else {
      process.env.LINEAR_API_KEY = previousToken;
    }

    if (previousSecret === undefined) {
      delete process.env.LINEAR_WEBHOOK_SECRET;
    } else {
      process.env.LINEAR_WEBHOOK_SECRET = previousSecret;
    }
  }
});

test("local sweep executes actionable local issues through the orchestration path", async () => {
  const fixture = createLocalCliFixture();
  await bootstrapLocalFixture(fixture.workspaceDir);
  const invokedWorkItemIds: string[] = [];

  const result = await runCli(
    ["local", "sweep", "--format", "json", "--limit", "5"],
    {
      cwd: () => fixture.workspaceDir,
      stdout: (message) => {
        fixture.stdout.push(message);
      },
      stderr: () => undefined,
      executeClaimedRunFn: async (_dependencies, input) => {
        invokedWorkItemIds.push(input.workItemId);
        return createExecutedSweepResult(input.workItemId);
      },
    },
  );

  assert.equal(result, 0);
  assert.deepEqual(invokedWorkItemIds, ["LOCAL-001"]);

  const parsed = JSON.parse(fixture.stdout.join("\n"));
  assert.equal(parsed.candidateCount, 1);
  assert.equal(parsed.executedCount, 1);
  assert.equal(parsed.noopCount, 0);
  assert.equal(parsed.results[0].workItemId, "LOCAL-001");
  assert.equal(parsed.results[0].outcome, "executed");
  assert.equal(parsed.results[0].runId, "run-local-sweep-001");
  assert.equal(parsed.results[0].runtimeStatus, "completed");
});

test("local sweep rejects non-local planning profiles", async () => {
  const fixture = createLocalCliFixture();
  await bootstrapLocalFixture(fixture.workspaceDir);

  const previousToken = process.env.LINEAR_API_KEY;
  const previousSecret = process.env.LINEAR_WEBHOOK_SECRET;
  process.env.LINEAR_API_KEY = "test-linear-token";
  process.env.LINEAR_WEBHOOK_SECRET = "test-linear-secret";

  try {
    await assert.rejects(
      () =>
        runCli(
          ["local", "sweep", "--profile", "hybrid"],
          {
            cwd: () => fixture.workspaceDir,
            stdout: () => undefined,
            stderr: () => undefined,
          },
        ),
      /requires planning\.local_files/i,
    );
  } finally {
    if (previousToken === undefined) {
      delete process.env.LINEAR_API_KEY;
    } else {
      process.env.LINEAR_API_KEY = previousToken;
    }

    if (previousSecret === undefined) {
      delete process.env.LINEAR_WEBHOOK_SECRET;
    } else {
      process.env.LINEAR_WEBHOOK_SECRET = previousSecret;
    }
  }
});

async function bootstrapLocalFixture(workspaceDir: string): Promise<void> {
  const initResult = await invokeCli(["init"], workspaceDir);
  assert.equal(initResult.exitCode, 0);

  const bootstrapResult = await invokeCli(["bootstrap"], workspaceDir);
  assert.equal(bootstrapResult.exitCode, 0);
}

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

function createLocalCliFixture(): { workspaceDir: string; stdout: string[] } {
  const workspaceDir = mkdtempSync(path.join(tmpdir(), "orq-local-cli-"));

  cpSync(
    path.join(REPO_ROOT, "config.example.toml"),
    path.join(workspaceDir, "config.example.toml"),
  );
  cpSync(
    path.join(REPO_ROOT, "docs", "prompts"),
    path.join(workspaceDir, "docs", "prompts"),
    {
      recursive: true,
    },
  );
  cpSync(
    path.join(REPO_ROOT, "examples", "local"),
    path.join(workspaceDir, "examples", "local"),
    {
      recursive: true,
    },
  );

  return { workspaceDir, stdout: [] };
}

function createExecutedSweepResult(
  workItemId: string,
): ExecuteClaimedRunResult {
  return {
    ok: true,
    prepared: {
      runId: "run-local-sweep-001",
      claimedWorkItem: {
        id: workItemId,
        identifier: workItemId,
        title: "Implement the local bootstrap happy path",
        description: null,
        status: "implement",
        phase: "implement",
        priority: 1,
        labels: [],
        url: null,
        parentId: null,
        dependencyIds: [],
        blockedByIds: [],
        blocksIds: [],
        artifactUrl: null,
        updatedAt: "2026-04-15T00:00:00.000Z",
        createdAt: "2026-04-15T00:00:00.000Z",
        orchestration: {
          state: "claimed",
          owner: "local-sweep-cli",
          runId: "run-local-sweep-001",
          leaseUntil: "2026-04-15T00:15:00.000Z",
          reviewOutcome: "none",
          blockedReason: null,
          lastError: null,
          attemptCount: 1,
        },
      },
    },
    execution: {
      watched: {
        run: {
          runId: "run-local-sweep-001",
          workItemId,
          workItemIdentifier: workItemId,
          phase: "implement",
          provider: "codex",
          status: "completed",
          repoRoot: "/tmp/repo",
          workspace: {
            mode: "ephemeral_worktree",
            workingDirHint: "/tmp/repo/.worktrees/run-local-sweep-001",
            assignedBranch: null,
            baseRef: null,
            pullRequestUrl: null,
            pullRequestMode: null,
            writeScope: null,
          },
          artifactUrl: null,
          requestedBy: "local:sweep",
          grantedCapabilities: [],
          promptContractId: "contract-local-sweep",
          promptDigests: {
            system: null,
            user: "user-prompt-digest",
          },
          promptProvenance: null,
          limits: {
            maxWallTimeSec: 5400,
            idleTimeoutSec: 300,
            bootstrapTimeoutSec: 120,
          },
          outcome: null,
          createdAt: "2026-04-15T00:00:00.000Z",
          admittedAt: null,
          startedAt: null,
          completedAt: "2026-04-15T00:01:00.000Z",
          lastHeartbeatAt: null,
          lastEventSeq: 10,
        },
        lastEventSeq: 10,
        waitingHumanReason: null,
        waitingHumanDetails: null,
      },
      prepared: {} as never,
      writeback: {} as never,
    },
    resolution: {
      actionable: true,
      phase: "implement",
    },
    decision: {
      claimable: true,
      phase: "implement",
      hasExpiredLease: false,
    },
  } as unknown as ExecuteClaimedRunResult;
}
