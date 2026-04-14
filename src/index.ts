import { fileURLToPath } from "node:url";

export * from "./config/index.js";
export * from "./core/index.js";
export * from "./domain-model.js";
export * from "./providers/index.js";
export * from "./runtime/index.js";

export function main(): void {
  console.log(
    "Orqestrate scaffold is installed. Start from docs/, then implement against the tracked Linear backlog."
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
