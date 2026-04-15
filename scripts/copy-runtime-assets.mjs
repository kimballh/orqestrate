import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

copyDirectory(
  path.join(repoRoot, "src", "runtime", "persistence", "sql"),
  path.join(repoRoot, "dist", "runtime", "persistence", "sql"),
);
copyDirectory(
  path.join(repoRoot, "src", "orchestrator", "sql"),
  path.join(repoRoot, "dist", "orchestrator", "sql"),
);

function copyDirectory(sourceDir, destinationDir) {
  mkdirSync(destinationDir, { recursive: true });
  cpSync(sourceDir, destinationDir, { recursive: true });
}
