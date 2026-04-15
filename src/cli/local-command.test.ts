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

function createLocalCliFixture(): { workspaceDir: string } {
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

  return { workspaceDir };
}
