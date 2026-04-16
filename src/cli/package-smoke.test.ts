import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const DIST_CLI_PATH = path.join(REPO_ROOT, "dist", "index.js");

test("packed install works from an external workspace", async (t) => {
  if (!existsSync(DIST_CLI_PATH)) {
    t.skip("dist build output is not present");
    return;
  }

  const tarballPath = await createPackagedTarball();
  const workspaceDir = createTempWorkspace("orq-pack-install-");
  const installedCliPath = path.join(workspaceDir, "node_modules", ".bin", "orq");

  t.after(() => {
    rmSync(tarballPath, { force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  await execFileAsync("npm", ["init", "-y"], {
    cwd: workspaceDir,
  });
  await execFileAsync("npm", ["install", tarballPath], {
    cwd: workspaceDir,
  });

  await assertInstalledWorkflow({
    cliPath: installedCliPath,
    workspaceDir,
    expectedPackageRoot: path.join(workspaceDir, "node_modules", "orqestrate"),
    verifyRuntime: true,
  });
});

test("linked install preserves installed package paths in generated config", async (t) => {
  const workspaceDir = createTempWorkspace("orq-link-install-");
  const prefixDir = createTempWorkspace("orq-link-prefix-");
  const installedCliPath = path.join(workspaceDir, "node_modules", ".bin", "orq");
  const linkEnv = {
    ...process.env,
    npm_config_prefix: prefixDir,
  };

  t.after(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(prefixDir, { recursive: true, force: true });
  });

  await execFileAsync("npm", ["link"], {
    cwd: REPO_ROOT,
    env: linkEnv,
  });
  await execFileAsync("npm", ["init", "-y"], {
    cwd: workspaceDir,
  });
  await execFileAsync("npm", ["link", "orqestrate"], {
    cwd: workspaceDir,
    env: linkEnv,
  });

  await assertInstalledWorkflow({
    cliPath: installedCliPath,
    workspaceDir,
    expectedPackageRoot: path.join(workspaceDir, "node_modules", "orqestrate"),
    verifyRuntime: false,
  });

  const generatedConfig = readFileSync(
    path.join(workspaceDir, "config.toml"),
    "utf8",
  );
  assert.match(
    generatedConfig,
    new RegExp(
      escapeForRegExp(
        path.join(workspaceDir, "node_modules", "orqestrate", "docs", "prompts"),
      ),
    ),
  );
  assert.doesNotMatch(
    generatedConfig,
    new RegExp(escapeForRegExp(path.join(REPO_ROOT, "docs", "prompts"))),
  );
});

async function assertInstalledWorkflow(options: {
  cliPath: string;
  workspaceDir: string;
  expectedPackageRoot: string;
  verifyRuntime: boolean;
}): Promise<void> {
  const helpResult = await execFileAsync(options.cliPath, ["--help"], {
    cwd: options.workspaceDir,
  });
  assert.match(helpResult.stdout, /Usage: orq <command>/);
  assert.match(helpResult.stdout, /orchestrator\s+Start the orchestrator service/);

  const orchestratorHelpResult = await execFileAsync(
    options.cliPath,
    ["orchestrator", "--help"],
    {
      cwd: options.workspaceDir,
    },
  );
  assert.match(orchestratorHelpResult.stdout, /orchestrator start/);

  const orchestratorStartHelpResult = await execFileAsync(
    options.cliPath,
    ["orchestrator", "start", "--help"],
    {
      cwd: options.workspaceDir,
    },
  );
  assert.match(orchestratorStartHelpResult.stdout, /--repo-root <path>/);

  const initResult = await execFileAsync(options.cliPath, ["init"], {
    cwd: options.workspaceDir,
  });
  assert.match(initResult.stdout, /Initialization complete\./);
  assert.match(
    initResult.stdout,
    new RegExp(
      escapeForRegExp(
        path.join("node_modules", "orqestrate", "config.example.toml"),
      ),
    ),
  );

  const generatedConfig = readFileSync(
    path.join(options.workspaceDir, "config.toml"),
    "utf8",
  );
  assert.match(
    generatedConfig,
    new RegExp(
      escapeForRegExp(path.join(options.expectedPackageRoot, "docs", "prompts")),
    ),
  );
  assert.match(
    generatedConfig,
    new RegExp(
      escapeForRegExp(
        path.join(
          options.expectedPackageRoot,
          "examples",
          "local",
          "context",
          "templates",
          "artifact.md",
        ),
      ),
    ),
  );

  const bootstrapResult = await execFileAsync(options.cliPath, ["bootstrap"], {
    cwd: options.workspaceDir,
  });
  assert.match(bootstrapResult.stdout, /Bootstrap complete\./);
  assert.equal(
    existsSync(
      path.join(
        options.workspaceDir,
        ".harness",
        "local",
        "planning",
        "index.json",
      ),
    ),
    true,
  );

  if (!options.verifyRuntime) {
    return;
  }

  const runtimeLog: string[] = [];
  const runtimeProcess = spawn(options.cliPath, ["runtime", "start"], {
    cwd: options.workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });

  runtimeProcess.stdout.on("data", (chunk) => {
    runtimeLog.push(String(chunk));
  });
  runtimeProcess.stderr.on("data", (chunk) => {
    runtimeLog.push(String(chunk));
  });

  const stopRuntime = () => {
    runtimeProcess.kill("SIGTERM");
  };

  try {
    const socketPath = path.join(
      options.workspaceDir,
      ".harness",
      "state",
      "sockets",
      "runtime.sock",
    );
    await waitForSocket(socketPath);
    const health = await requestRuntimeHealth(socketPath);
    assert.equal(health.ok, true, runtimeLog.join(""));
  } finally {
    stopRuntime();
  }

  const orchestratorLog: string[] = [];
  const orchestratorProcess = spawn(
    options.cliPath,
    [
      "orchestrator",
      "start",
      "--profile",
      "local",
      "--repo-root",
      options.workspaceDir,
    ],
    {
      cwd: options.workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  orchestratorProcess.stdout.on("data", (chunk) => {
    orchestratorLog.push(String(chunk));
  });
  orchestratorProcess.stderr.on("data", (chunk) => {
    orchestratorLog.push(String(chunk));
  });

  try {
    await waitForLogLine(orchestratorLog, /Orchestrator service ready/);
    const orchestratorDatabasePath = path.join(
      options.workspaceDir,
      ".harness",
      "state",
      "orchestrator.sqlite",
    );
    await waitForFile(orchestratorDatabasePath);
    assert.equal(
      existsSync(orchestratorDatabasePath),
      true,
      orchestratorLog.join(""),
    );
  } finally {
    orchestratorProcess.kill("SIGTERM");
  }
}

async function createPackagedTarball(): Promise<string> {
  const packResult = await execFileAsync("npm", ["pack", "--json"], {
    cwd: REPO_ROOT,
  });
  const parsed = JSON.parse(packResult.stdout) as Array<{ filename: string }>;
  return path.join(REPO_ROOT, parsed[0].filename);
}

function createTempWorkspace(prefix: string): string {
  return mkdtempSync(path.join("/tmp", prefix));
}

async function waitForSocket(socketPath: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(socketPath)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Runtime socket '${socketPath}' was not created in time.`);
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(filePath)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Expected file '${filePath}' was not created in time.`);
}

async function waitForLogLine(log: string[], pattern: RegExp): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (pattern.test(log.join(""))) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Expected log pattern '${pattern.source}' did not appear.`);
}

async function requestRuntimeHealth(
  socketPath: string,
): Promise<{ ok: boolean }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        path: "/v1/health",
        method: "GET",
        host: "runtime.local",
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `Runtime health check failed with status ${response.statusCode}.`,
              ),
            );
            return;
          }

          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        });
      },
    );

    request.on("error", reject);
    request.end();
  });
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
