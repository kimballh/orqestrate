import assert from "node:assert/strict";
import test from "node:test";

import type { LoadedConfig } from "../config/types.js";
import { runOrchestratorCommand } from "./orchestrator-command.js";

test("orchestrator help includes the start subcommand", async () => {
  const stdout: string[] = [];
  const exitCode = await runOrchestratorCommand(["--help"], {
    stdout: (message) => stdout.push(message),
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.join("\n"), /orchestrator start/);
});

test("orchestrator start help describes the supported options", async () => {
  const stdout: string[] = [];
  const exitCode = await runOrchestratorCommand(["start", "--help"], {
    stdout: (message) => stdout.push(message),
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.join("\n"), /--repo-root <path>/);
  assert.match(stdout.join("\n"), /--provider <name>/);
  assert.match(stdout.join("\n"), /--host <value>/);
  assert.match(stdout.join("\n"), /--port <value>/);
});

test("orchestrator start loads config and starts the service with resolved options", async () => {
  let loadedOptions:
    | {
        cwd?: string;
        configPath?: string;
        activeProfile?: string;
        env?: NodeJS.ProcessEnv;
      }
    | undefined;
  let startOptions: unknown;
  let startLog: string | undefined;

  const exitCode = await runOrchestratorCommand(
    [
      "start",
      "--config",
      "config.test.toml",
      "--profile",
      "hybrid",
      "--repo-root",
      "/tmp/orq-repo",
      "--provider",
      "claude",
      "--host",
      "0.0.0.0",
      "--port",
      "4010",
    ],
    {
      cwd: () => "/tmp/orq-workspace",
      loadConfig: async (options) => {
        loadedOptions = options;
        return {
          sourcePath: "/tmp/orq-workspace/config.test.toml",
          activeProfileName: "hybrid",
        } as LoadedConfig;
      },
      startOrchestratorMain: async (_loadedConfig, options, dependencies) => {
        startOptions = options;
        dependencies?.log?.("ready");
        startLog = "ready";
        return {
          planning: {} as never,
          context: {} as never,
          runtime: {} as never,
          runtimeObserver: {} as never,
          actionableSweepLoop: null,
          reconciliationLoop: {} as never,
          wakeupRepository: {} as never,
          wakeupLoop: {} as never,
          webhookServer: null,
          stop: async () => undefined,
        };
      },
      stdout: (message) => {
        if (message !== "ready") {
          throw new Error(`unexpected stdout: ${message}`);
        }
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(loadedOptions?.cwd, "/tmp/orq-workspace");
  assert.deepEqual(loadedOptions?.configPath, "config.test.toml");
  assert.deepEqual(loadedOptions?.activeProfile, "hybrid");
  assert.equal(loadedOptions?.env, process.env);
  assert.deepEqual(startOptions, {
    configPath: "config.test.toml",
    activeProfile: "hybrid",
    repoRoot: "/tmp/orq-repo",
    provider: "claude",
    host: "0.0.0.0",
    port: 4010,
  });
  assert.equal(startLog, "ready");
});
