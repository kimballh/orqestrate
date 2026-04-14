import { fileURLToPath } from "node:url";

export function main(): void {
  console.log(
    "Orqestrate scaffold is installed. Start from docs/, then implement against the tracked Linear backlog."
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
