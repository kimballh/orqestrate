import assert from "node:assert/strict";
import test from "node:test";

import type { LoadedConfig } from "../config/types.js";
import { runRuntimeCommand } from "./runtime-command.js";

test("runtime help includes the start subcommand", async () => {
  const stdout: string[] = [];
  const exitCode = await runRuntimeCommand(["--help"], {
    stdout: (message) => stdout.push(message),
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.join("\n"), /runtime start/);
});

test("runtime start loads config and starts the runtime service", async () => {
  const calls: string[] = [];
  let loadedOptions:
    | {
        cwd?: string;
        configPath?: string;
        activeProfile?: string;
        env?: NodeJS.ProcessEnv;
      }
    | undefined;
  const exitCode = await runRuntimeCommand(
    ["start", "--config", "config.test.toml", "--profile", "hybrid"],
    {
      cwd: () => "/tmp/orq-runtime",
      stdout: (message) => calls.push(`stdout:${message}`),
      loadConfig: async (options) => {
        loadedOptions = options;
        return {
          sourcePath: "/tmp/orq-runtime/config.test.toml",
          activeProfileName: "hybrid",
        } as LoadedConfig;
      },
      startRuntimeService: async (loadedConfig, dependencies) => {
        calls.push(`runtime:${loadedConfig.activeProfileName}`);
        dependencies?.log?.("ready");
        return {
          daemon: {} as never,
          apiServer: {} as never,
        };
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(loadedOptions?.cwd, "/tmp/orq-runtime");
  assert.deepEqual(loadedOptions?.configPath, "config.test.toml");
  assert.deepEqual(loadedOptions?.activeProfile, "hybrid");
  assert.equal(loadedOptions?.env, process.env);
  assert.deepEqual(calls, [
    "runtime:hybrid",
    "stdout:ready",
  ]);
});
