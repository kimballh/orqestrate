import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { defineContextBackendContract } from "../../test/contracts/context-backend-contract.js";

import { LocalFilesContextBackend } from "./local-files-backend.js";

defineContextBackendContract({
  providerName: "context.local_files",
  async setup() {
    const root = await mkdtemp(path.join(tmpdir(), "orq-local-context-contract-"));
    const backend = new LocalFilesContextBackend({
      name: "local_context",
      family: "context",
      kind: "context.local_files",
      root,
      templates: {},
    });
    await backend.validateConfig();

    return {
      backend,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  },
});
