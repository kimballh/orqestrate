import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { WorkItemRecord } from "../../domain-model.js";
import { definePlanningBackendContract } from "../../test/contracts/planning-backend-contract.js";

import { LocalFilesPlanningBackend } from "./local-files-backend.js";

definePlanningBackendContract({
  providerName: "planning.local_files",
  async setup(input) {
    const root = await mkdtemp(path.join(os.tmpdir(), "orq-local-planning-contract-"));
    await seedIssues(root, input.workItems);

    const backend = new LocalFilesPlanningBackend({
      name: "local_planning",
      kind: "planning.local_files",
      family: "planning",
      root,
    });
    await backend.validateConfig();

    return {
      backend,
      cleanup: () => rm(root, { recursive: true, force: true }),
      async getCommentBodies(workItemId) {
        const commentPath = path.join(root, "comments", `${workItemId}.md`);
        const contents = await readFile(commentPath, "utf8").catch(() => "");
        return [...contents.matchAll(/^## [^\n]+\n\n([\s\S]*?)(?=\n## |\n*$)/gm)].map(
          (match) => match[1]?.trim() ?? "",
        );
      },
      getExpectedDeepLink(workItemId) {
        return pathToFileURL(path.join(root, "issues", `${workItemId}.json`)).toString();
      },
    };
  },
});

async function seedIssues(root: string, records: WorkItemRecord[]): Promise<void> {
  await mkdir(path.join(root, "issues"), { recursive: true });

  for (const record of records) {
    await writeFile(
      path.join(root, "issues", `${record.id}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
  }
}
