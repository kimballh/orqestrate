import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const sourceDir = path.join(repoRoot, "src", "runtime", "persistence", "sql");
const destinationDir = path.join(
  repoRoot,
  "dist",
  "runtime",
  "persistence",
  "sql",
);

mkdirSync(destinationDir, { recursive: true });
cpSync(sourceDir, destinationDir, { recursive: true });
