import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
} from "node:fs";
import {
  access,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ContextLocalFilesProviderConfig,
  LoadedConfig,
} from "../../config/types.js";
import type { WorkItemRecord } from "../../domain-model.js";
import { LocalFilesContextBackend } from "./local-files-backend.js";

const WORK_ITEM = {
  id: "linear-issue-id",
  identifier: "ORQ-24",
  title: "Implement local_files context backend",
  description: "Persist artifacts, run ledgers, and evidence locally.",
  status: "implement",
  phase: "implement",
  priority: 2,
  labels: ["backend"],
  url: "https://linear.app/orqestrate/issue/ORQ-24",
  parentId: "ORQ-8",
  dependencyIds: ["ORQ-18"],
  blockedByIds: [],
  blocksIds: ["ORQ-25", "ORQ-50"],
  artifactUrl: null,
  updatedAt: "2026-04-14T00:00:00.000Z",
  createdAt: "2026-04-13T23:54:22.162Z",
  orchestration: {
    state: "queued",
    owner: null,
    runId: null,
    leaseUntil: null,
    reviewOutcome: "none",
    blockedReason: null,
    lastError: null,
    attemptCount: 0,
  },
} satisfies WorkItemRecord;

test("validateConfig bootstraps the local context directory tree", async () => {
  const backend = createBackend();

  await backend.validateConfig();

  await Promise.all([
    access(path.join(backend.config.root, "artifacts")),
    access(path.join(backend.config.root, "runs")),
    access(path.join(backend.config.root, "evidence")),
  ]);
});

test("ensureArtifact creates the markdown artifact and metadata sidecar idempotently", async () => {
  const backend = createBackend();

  const firstArtifact = await backend.ensureArtifact({ workItem: WORK_ITEM });
  const secondArtifact = await backend.ensureArtifact({ workItem: WORK_ITEM });

  assert.deepEqual(secondArtifact, firstArtifact);
  assert.equal(firstArtifact.state, "draft");
  assert.equal(firstArtifact.phase, "none");
  assert.equal(firstArtifact.designReady, false);
  assert.equal(firstArtifact.planReady, false);
  assert.equal(firstArtifact.implementationNotesPresent, false);
  assert.equal(firstArtifact.reviewSummaryPresent, false);
  assert.equal(firstArtifact.verificationEvidencePresent, false);
  assert.ok(firstArtifact.url);
  assert.match(readFileSync(firstArtifact.url ?? "", "utf8"), /# Context/);
  assert.match(readFileSync(firstArtifact.url ?? "", "utf8"), /orqestrate:phase:plan:start/);
});

test("getArtifactByWorkItemId returns null before creation and metadata after creation", async () => {
  const backend = createBackend();

  assert.equal(await backend.getArtifactByWorkItemId(WORK_ITEM.id), null);

  const createdArtifact = await backend.ensureArtifact({ workItem: WORK_ITEM });
  const loadedArtifact = await backend.getArtifactByWorkItemId(WORK_ITEM.id);

  assert.deepEqual(loadedArtifact, createdArtifact);
});

test("writePhaseArtifact updates only the targeted section and readiness flag", async () => {
  const backend = createBackend();
  const artifact = await backend.ensureArtifact({ workItem: WORK_ITEM });

  await backend.writePhaseArtifact({
    workItem: WORK_ITEM,
    artifact,
    phase: "plan",
    content: "Implementation plan for ORQ-24.",
    summary: "Plan is ready.",
  });

  const storedArtifact = await backend.getArtifactByWorkItemId(WORK_ITEM.id);
  const markdown = readFileSync(artifact.url ?? "", "utf8");

  assert.ok(storedArtifact);
  assert.equal(storedArtifact.phase, "plan");
  assert.equal(storedArtifact.state, "ready");
  assert.equal(storedArtifact.planReady, true);
  assert.equal(storedArtifact.designReady, false);
  assert.equal(storedArtifact.summary, "Plan is ready.");
  assert.match(markdown, /Implementation plan for ORQ-24\./);
  assert.match(markdown, /Pending review notes\./);
});

test("run ledgers, evidence, and context bundles are persisted and summarized", async () => {
  const backend = createBackend();
  const artifact = await backend.ensureArtifact({ workItem: WORK_ITEM });

  await backend.writePhaseArtifact({
    workItem: WORK_ITEM,
    artifact,
    phase: "implement",
    content: "Implemented the local-files backend.",
    summary: "Implementation landed.",
  });

  await backend.createRunLedgerEntry({
    runId: "run-1",
    workItem: WORK_ITEM,
    phase: "implement",
    status: "running",
  });
  const finalizedRun = await backend.finalizeRunLedgerEntry({
    runId: "run-1",
    status: "completed",
    summary: "Checks passed.",
  });

  await backend.appendEvidence({
    runId: "run-1",
    workItemId: WORK_ITEM.id,
    section: "Verification",
    content: "npm run check",
  });

  const storedArtifact = await backend.getArtifactByWorkItemId(WORK_ITEM.id);
  const bundle = await backend.loadContextBundle({
    workItem: WORK_ITEM,
    artifact: storedArtifact,
    phase: "implement",
  });

  assert.equal(finalizedRun.status, "completed");
  assert.ok(storedArtifact);
  assert.equal(storedArtifact.verificationEvidencePresent, true);
  assert.doesNotMatch(bundle.contextText, /No verification evidence captured yet\./);
  assert.match(bundle.contextText, /Verification evidence file:/);
  assert.match(bundle.contextText, /Implemented the local-files backend\./);
  assert.match(bundle.contextText, /# Recent Run History/);
  assert.match(bundle.contextText, /run-1/);
  assert.deepEqual(
    bundle.references.map((reference) => reference.kind),
    ["artifact", "run_ledger", "evidence"],
  );

  const evidence = readFileSync(
    path.join(backend.config.root, "evidence", "run-1.md"),
    "utf8",
  );

  assert.match(evidence, /# Evidence/);
  assert.match(evidence, /## .* - Verification/);
  assert.match(evidence, /npm run check/);
});

test("rejects unsafe run ids before writing outside the backend root", async () => {
  const backend = createBackend();
  const escapedRunPath = path.join(backend.config.root, "..", "escaped.json");

  await assert.rejects(
    () =>
      backend.createRunLedgerEntry({
        runId: "../escaped",
        workItem: WORK_ITEM,
        phase: "implement",
        status: "running",
      }),
    /filesystem-safe/,
  );

  await assert.rejects(() => access(escapedRunPath));
});

test("configured template overrides seed artifact and evidence content", async () => {
  const fixture = createFixtureWorkspace();
  const artifactTemplatePath = path.join(fixture.rootDir, "artifact-template.md");
  const evidenceTemplatePath = path.join(fixture.rootDir, "evidence-template.md");

  await Promise.all([
    writeFile(
      artifactTemplatePath,
      "Custom context for {{workItem.identifier}}: {{workItem.title}}\n",
      "utf8",
    ),
    writeFile(
      evidenceTemplatePath,
      "Evidence header for {{runId}} and {{workItemId}}\n",
      "utf8",
    ),
  ]);

  const backend = createBackend({
    root: fixture.rootDir,
    templates: {
      artifact_template: artifactTemplatePath,
      run_template: evidenceTemplatePath,
    },
  });

  const artifact = await backend.ensureArtifact({ workItem: WORK_ITEM });

  await backend.appendEvidence({
    runId: "run-template",
    workItemId: WORK_ITEM.id,
    section: "Verification",
    content: "custom check output",
  });

  assert.match(readFileSync(artifact.url ?? "", "utf8"), /Custom context for ORQ-24/);
  assert.match(
    readFileSync(path.join(fixture.rootDir, "evidence", "run-template.md"), "utf8"),
    /Evidence header for run-template and linear-issue-id/,
  );
});

test("config parsing resolves local context template paths relative to the config file", async () => {
  const fixture = createFixtureWorkspace();
  const configPath = path.join(fixture.rootDir, "config.toml");
  const promptRoot = path.join(fixture.rootDir, "prompts");

  await mkdir(path.join(promptRoot, "base"), { recursive: true });
  await mkdir(path.join(fixture.rootDir, "templates"), { recursive: true });
  await writeFile(path.join(promptRoot, "base", "system.md"), "system prompt", "utf8");
  await writeFile(
    configPath,
    `version = 1
active_profile = "local"

[paths]
state_dir = ".harness/state"
data_dir = ".harness/data"
log_dir = ".harness/logs"

[prompts]
root = "./prompts"

[prompt_packs.default]
base_system = "base/system.md"

[providers.local_planning]
kind = "planning.local_files"
root = ".harness/local/planning"

[providers.local_context]
kind = "context.local_files"
root = ".harness/local/context"

[providers.local_context.templates]
artifact_template = "./templates/artifact.md"

[profiles.local]
planning = "local_planning"
context = "local_context"
prompt_pack = "default"
`,
    "utf8",
  );
  await writeFile(path.join(fixture.rootDir, "templates", "artifact.md"), "artifact", "utf8");

  const module = await import("../../config/loader.js");
  const config = (await module.loadConfig({
    configPath,
    env: {},
  })) as LoadedConfig;
  const provider = config.activeProfile.contextProvider;

  assert.equal(provider.kind, "context.local_files");
  assert.equal(
    provider.templates.artifact_template,
    path.join(fixture.rootDir, "templates", "artifact.md"),
  );
});

function createBackend(
  overrides: Partial<ContextLocalFilesProviderConfig> = {},
): LocalFilesContextBackend {
  const fixture = createFixtureWorkspace();

  return new LocalFilesContextBackend({
    name: "local_context",
    family: "context",
    kind: "context.local_files",
    root: path.join(fixture.rootDir, ".harness", "local", "context"),
    templates: {},
    ...overrides,
  });
}

function createFixtureWorkspace(): { rootDir: string } {
  return {
    rootDir: mkdtempSync(path.join(tmpdir(), "orq-local-context-")),
  };
}
