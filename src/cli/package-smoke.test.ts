import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
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

test("built CLI works from an external workspace", async (t) => {
  if (!existsSync(DIST_CLI_PATH)) {
    t.skip("dist build output is not present");
    return;
  }

  const workspaceDir = mkdtempSync("/tmp/orq-package-smoke-");
  t.after(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  const helpResult = await execFileAsync("node", [DIST_CLI_PATH, "--help"], {
    cwd: workspaceDir,
  });
  assert.match(helpResult.stdout, /Usage: orq <command>/);

  const initResult = await execFileAsync("node", [DIST_CLI_PATH, "init"], {
    cwd: workspaceDir,
  });
  assert.match(initResult.stdout, /Initialization complete\./);
  assert.match(initResult.stdout, /Source: .*config\.example\.toml/);

  const generatedConfig = readFileSync(
    path.join(workspaceDir, "config.toml"),
    "utf8",
  );
  assert.match(generatedConfig, /root = ".*docs[\\/\\\\]prompts"/);

  const bootstrapResult = await execFileAsync(
    "node",
    [DIST_CLI_PATH, "bootstrap"],
    {
      cwd: workspaceDir,
    },
  );
  assert.match(bootstrapResult.stdout, /Bootstrap complete\./);
  assert.equal(
    existsSync(
      path.join(workspaceDir, ".harness", "local", "planning", "index.json"),
    ),
    true,
  );

  const runtimeLog: string[] = [];
  const runtimeProcess = spawn("node", [DIST_CLI_PATH, "runtime", "start"], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  runtimeProcess.stdout.on("data", (chunk) => {
    runtimeLog.push(String(chunk));
  });
  runtimeProcess.stderr.on("data", (chunk) => {
    runtimeLog.push(String(chunk));
  });
  t.after(() => {
    runtimeProcess.kill("SIGTERM");
  });

  const socketPath = path.join(
    workspaceDir,
    ".harness",
    "state",
    "sockets",
    "runtime.sock",
  );
  await waitForSocket(socketPath);
  const health = await requestRuntimeHealth(socketPath);
  assert.equal(health.ok, true, runtimeLog.join(""));
});

async function waitForSocket(socketPath: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (existsSync(socketPath)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Runtime socket '${socketPath}' was not created in time.`);
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
