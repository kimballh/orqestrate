import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config/loader.ts";
import { materializeLocalExampleForProfile } from "../src/core/local-example.ts";

function resolveRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

async function main(argv = process.argv.slice(2)) {
  const repoRoot = resolveRepoRoot();
  const force = argv.includes("--force");
  const loadedConfig = await loadConfig({
    configPath: path.join(repoRoot, "config.example.toml"),
    activeProfile: "local",
    env: process.env,
  });
  const result = await materializeLocalExampleForProfile(loadedConfig, {
    repoRoot,
    overwrite: force,
  });

  console.log("Local example ready.");
  console.log(`Planning root: ${result.planningRoot}`);
  console.log(`Planning seed: ${result.planningSeedState}`);
  console.log(`Context root: ${result.contextRoot}`);
  console.log(`Seed issues: ${result.issueCount}`);
  console.log(`Actionable work items: ${result.actionableCount}`);
}

main().catch((error) => {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error("Failed to materialize the local example.");
  }

  process.exitCode = 1;
});
