import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "../index.js";
import { loadConfig } from "../config/loader.js";
import { LocalFilesPlanningBackend } from "../providers/planning/local-files-backend.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

test("top-level help includes the setup commands", async () => {
  const fixture = createSetupCliFixture();
  const result = await invokeCli(["--help"], fixture.workspaceDir);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /init\s+Create a starter config\.toml/);
  assert.match(result.stdout, /bootstrap\s+Validate the selected profile/);
});

test("init creates config.toml from the canonical example and can override the profile", async () => {
  const fixture = createSetupCliFixture();
  const result = await invokeCli(
    ["init", "--profile", "hybrid"],
    fixture.workspaceDir,
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Initialization complete\./);
  assert.match(result.stdout, /Profile: hybrid/);
  assert.match(
    result.stdout,
    /replace placeholder credentials, then run: npm run orq:bootstrap/,
  );
  assert.equal(
    readFileSync(path.join(fixture.workspaceDir, "config.toml"), "utf8").includes(
      'active_profile = "hybrid"',
    ),
    true,
  );
});

test("init refuses to overwrite an existing config.toml without --force", async () => {
  const fixture = createSetupCliFixture();
  await invokeCli(["init"], fixture.workspaceDir);

  await assert.rejects(
    () =>
      runCli(["init"], {
        cwd: () => fixture.workspaceDir,
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    /already exists/i,
  );
});

test("bootstrap seeds the local example and validates the local profile", async () => {
  const fixture = createSetupCliFixture();
  const initResult = await invokeCli(["init"], fixture.workspaceDir);

  assert.match(initResult.stdout, /Next steps:\n  npm run orq:bootstrap/);
  const result = await invokeCli(["bootstrap"], fixture.workspaceDir);
  const config = await loadConfig({
    configPath: path.join(fixture.workspaceDir, "config.toml"),
    env: {},
  });

  if (config.activeProfile.planningProvider.kind !== "planning.local_files") {
    throw new Error("expected setup fixture to use planning.local_files");
  }

  const planningBackend = new LocalFilesPlanningBackend(
    config.activeProfile.planningProvider,
  );
  const actionable = await planningBackend.listActionableWorkItems({ limit: 10 });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Bootstrap complete\./);
  assert.match(result.stdout, /Planning seed: seeded/);
  assert.equal(
    existsSync(
      path.join(fixture.workspaceDir, ".harness", "local", "planning", "index.json"),
    ),
    true,
  );
  assert.deepEqual(actionable.map((item) => item.id), ["LOCAL-001"]);
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

function createSetupCliFixture(): { workspaceDir: string } {
  const workspaceDir = mkdtempSync(path.join(tmpdir(), "orq-setup-cli-"));

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
