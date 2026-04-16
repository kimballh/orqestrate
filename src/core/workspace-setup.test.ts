import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resolveWorkspaceSetup,
  WorkspaceSetupResolutionError,
} from "./workspace-setup.js";

test("prefers an explicit workspace setup script over Codex fallback metadata", async () => {
  const fixture = createFixtureWorkspace();
  const explicitScriptPath = path.join(fixture.workspaceDir, "scripts", "prepare.sh");
  mkdirSync(path.dirname(explicitScriptPath), { recursive: true });
  writeFileSync(explicitScriptPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  writeFileSync(
    path.join(fixture.workspaceDir, ".codex", "environments", "environment.toml"),
    `[setup]
script = """
echo "fallback"
"""
`,
    "utf8",
  );

  const resolved = await resolveWorkspaceSetup({
    repoRoot: fixture.workspaceDir,
    workspace: {
      setupScript: explicitScriptPath,
    },
  });

  assert.deepEqual(resolved, {
    source: "config",
    scriptPath: explicitScriptPath,
  });
});

test("falls back to a Codex environment setup script when explicit config is absent", async () => {
  const fixture = createFixtureWorkspace();
  const environmentPath = path.join(
    fixture.workspaceDir,
    ".codex",
    "environments",
    "environment.toml",
  );
  writeFileSync(
    environmentPath,
    `[setup]
script = """
#!/usr/bin/env bash
echo "prepare"
"""
`,
    "utf8",
  );

  const resolved = await resolveWorkspaceSetup({
    repoRoot: fixture.workspaceDir,
    workspace: {},
  });

  assert.deepEqual(resolved, {
    source: "codex_environment",
    environmentPath,
    script: '#!/usr/bin/env bash\necho "prepare"\n',
  });
});

test("returns null when no explicit config or Codex fallback exists", async () => {
  const fixture = createFixtureWorkspace();

  const resolved = await resolveWorkspaceSetup({
    repoRoot: fixture.workspaceDir,
    workspace: {},
  });

  assert.equal(resolved, null);
});

test("fails clearly when the explicit workspace setup script is missing", async () => {
  const fixture = createFixtureWorkspace();
  const missingScriptPath = path.join(
    fixture.workspaceDir,
    "scripts",
    "missing-setup.sh",
  );

  await assert.rejects(
    () =>
      resolveWorkspaceSetup({
        repoRoot: fixture.workspaceDir,
        workspace: {
          setupScript: missingScriptPath,
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceSetupResolutionError);
      assert.match(error.message, /workspace\.setup_script/);
      assert.equal(error.providerError.retryable, false);
      return true;
    },
  );
});

test("fails clearly when the Codex environment fallback is malformed", async () => {
  const fixture = createFixtureWorkspace();
  writeFileSync(
    path.join(fixture.workspaceDir, ".codex", "environments", "environment.toml"),
    `[setup]
script = 42
`,
    "utf8",
  );

  await assert.rejects(
    () =>
      resolveWorkspaceSetup({
        repoRoot: fixture.workspaceDir,
        workspace: {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceSetupResolutionError);
      assert.match(error.message, /\[setup\]\.script/);
      assert.equal(error.providerError.retryable, false);
      return true;
    },
  );
});

function createFixtureWorkspace(): { workspaceDir: string } {
  const workspaceDir = mkdtempSync(
    path.join(tmpdir(), "orqestrate-workspace-setup-"),
  );
  mkdirSync(path.join(workspaceDir, ".codex", "environments"), {
    recursive: true,
  });
  return { workspaceDir };
}
