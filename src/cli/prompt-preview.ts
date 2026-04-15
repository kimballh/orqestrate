import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { resolvePromptSelection } from "../config/prompt-selection.js";
import type { LoadedConfig } from "../config/types.js";
import {
  PROMPT_ATTACHMENT_KINDS,
  WORKSPACE_MODES,
  type PromptAttachment,
  type WorkPhase,
  type WorkspaceMode,
} from "../domain-model.js";
import {
  assemblePrompt,
  type PromptAssemblyContext,
  type PromptAssemblyResult,
} from "../core/prompt-assembly.js";

const WORKSPACE_MODE_SET = new Set<string>(WORKSPACE_MODES);
const PROMPT_ATTACHMENT_KIND_SET = new Set<string>(PROMPT_ATTACHMENT_KINDS);

type PromptContextPatch = {
  runId?: string | null;
  workItem?: Partial<PromptAssemblyContext["workItem"]>;
  artifact?: PromptAssemblyContext["artifact"];
  workspace?: Partial<PromptAssemblyContext["workspace"]>;
  expectations?: Partial<PromptAssemblyContext["expectations"]>;
  operatorNote?: string | null;
  additionalContext?: string | null;
  attachments?: PromptAttachment[];
};

export type PromptPreviewSelectionOverrides = {
  promptPackName?: string;
  capabilities?: string[];
  experiment?: string | null;
  organizationOverlays?: string[];
  projectOverlays?: string[];
};

export type PromptPreviewRequest = {
  role: WorkPhase;
  phase: WorkPhase;
  selection?: PromptPreviewSelectionOverrides;
  contextFilePath?: string;
  cwd?: string;
};

export type PromptPreviewSelectionSummary = {
  profileName: string;
  promptPackName: string;
  capabilities: string[];
  organizationOverlays: string[];
  projectOverlays: string[];
  experiment: string | null;
};

export type PromptPreviewResult = {
  profileName: string;
  role: WorkPhase;
  phase: WorkPhase;
  context: PromptAssemblyContext;
  contextFilePath?: string;
  contextSource: "synthetic" | "context_file";
  selection: PromptPreviewSelectionSummary;
  prompt: PromptAssemblyResult["prompt"];
  resolvedLayers: PromptAssemblyResult["resolvedLayers"];
};

export class PromptPreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptPreviewError";
  }
}

export async function renderPromptPreview(
  config: LoadedConfig,
  request: PromptPreviewRequest,
): Promise<PromptPreviewResult> {
  const cwd = path.resolve(request.cwd ?? process.cwd());
  const selectionOverrides = request.selection ?? {};
  const contextFilePath =
    request.contextFilePath === undefined
      ? undefined
      : path.resolve(cwd, request.contextFilePath);
  const context = await loadPromptPreviewContext({
    cwd,
    contextFilePath,
  });
  const selection = resolvePromptSelection(config, {
    promptPackName: selectionOverrides.promptPackName,
    experiment: selectionOverrides.experiment,
    organizationOverlays: selectionOverrides.organizationOverlays,
    projectOverlays: selectionOverrides.projectOverlays,
  });
  const capabilities = dedupeStrings(selectionOverrides.capabilities ?? []);
  const assembly = await assemblePrompt(config, {
    promptPackName: selectionOverrides.promptPackName,
    role: request.role,
    phase: request.phase,
    capabilities,
    experiment: selectionOverrides.experiment,
    organizationOverlays: selectionOverrides.organizationOverlays,
    projectOverlays: selectionOverrides.projectOverlays,
    context,
  });

  return {
    profileName: config.activeProfileName,
    role: request.role,
    phase: request.phase,
    context,
    contextFilePath,
    contextSource: contextFilePath === undefined ? "synthetic" : "context_file",
    selection: {
      profileName: config.activeProfileName,
      promptPackName: selection.promptPackName,
      capabilities,
      organizationOverlays: selection.overlays.organization.map(
        (overlay) => overlay.name,
      ),
      projectOverlays: selection.overlays.project.map((overlay) => overlay.name),
      experiment: selection.experiment?.name ?? null,
    },
    prompt: assembly.prompt,
    resolvedLayers: assembly.resolvedLayers,
  };
}

async function loadPromptPreviewContext(input: {
  cwd: string;
  contextFilePath?: string;
}): Promise<PromptAssemblyContext> {
  const defaultContext = await createSyntheticPreviewContext(input.cwd);

  if (input.contextFilePath === undefined) {
    return defaultContext;
  }

  let source: string;

  try {
    source = await readFile(input.contextFilePath, "utf8");
  } catch (error) {
    throw new PromptPreviewError(
      `Failed to read context file '${input.contextFilePath}'.`,
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(source);
  } catch {
    throw new PromptPreviewError(
      `Context file '${input.contextFilePath}' does not contain valid JSON.`,
    );
  }

  const patch = parsePromptContextPatch(parsed, input.contextFilePath);
  return mergePromptContext(defaultContext, patch);
}

async function createSyntheticPreviewContext(
  cwd: string,
): Promise<PromptAssemblyContext> {
  const repoRoot = await findRepoRoot(cwd);

  return {
    runId: null,
    workItem: {
      id: "prompt-preview",
      identifier: "(preview)",
      title: "Prompt Preview",
      description: "Synthetic preview render created from local config.",
      labels: [],
      url: null,
    },
    artifact: null,
    workspace: {
      repoRoot,
      workingDir: cwd,
      mode: "shared_readonly",
      assignedBranch: null,
      baseBranch: null,
      pullRequestUrl: null,
      pullRequestMode: null,
      writeScope: null,
    },
    expectations: {
      expectedOutputs: [],
      verificationRequired: false,
      requiredRepoChecks: [],
      testExpectations: null,
    },
    operatorNote: null,
    additionalContext: null,
    attachments: [],
  };
}

async function findRepoRoot(startDir: string): Promise<string> {
  let current = startDir;

  while (true) {
    if (
      (await pathExists(path.join(current, ".git"))) ||
      (await pathExists(path.join(current, "package.json")))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return startDir;
    }

    current = parent;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function mergePromptContext(
  base: PromptAssemblyContext,
  patch: PromptContextPatch,
): PromptAssemblyContext {
  return {
    runId: patch.runId === undefined ? base.runId : patch.runId,
    workItem: {
      ...base.workItem,
      ...(patch.workItem ?? {}),
    },
    artifact:
      patch.artifact === undefined
        ? base.artifact
        : patch.artifact === null
          ? null
          : {
              ...(base.artifact ?? {}),
              ...patch.artifact,
            },
    workspace: {
      ...base.workspace,
      ...(patch.workspace ?? {}),
    },
    expectations: {
      ...base.expectations,
      ...(patch.expectations ?? {}),
    },
    operatorNote:
      patch.operatorNote === undefined ? base.operatorNote : patch.operatorNote,
    additionalContext:
      patch.additionalContext === undefined
        ? base.additionalContext
        : patch.additionalContext,
    attachments:
      patch.attachments === undefined ? base.attachments : patch.attachments,
  };
}

function parsePromptContextPatch(
  value: unknown,
  sourceLabel: string,
): PromptContextPatch {
  const record = expectRecord(value, sourceLabel);
  assertAllowedKeys(
    record,
    [
      "runId",
      "workItem",
      "artifact",
      "workspace",
      "expectations",
      "operatorNote",
      "additionalContext",
      "attachments",
    ],
    sourceLabel,
  );

  return {
    runId: readOptionalNullableString(record, "runId", sourceLabel),
    workItem: parseWorkItemPatch(record.workItem, sourceLabel),
    artifact: parseArtifactPatch(record.artifact, sourceLabel),
    workspace: parseWorkspacePatch(record.workspace, sourceLabel),
    expectations: parseExpectationsPatch(record.expectations, sourceLabel),
    operatorNote: readOptionalNullableString(record, "operatorNote", sourceLabel),
    additionalContext: readOptionalNullableString(
      record,
      "additionalContext",
      sourceLabel,
    ),
    attachments: parseAttachments(record.attachments, sourceLabel),
  };
}

function parseWorkItemPatch(
  value: unknown,
  sourceLabel: string,
): PromptContextPatch["workItem"] {
  if (value === undefined) {
    return undefined;
  }

  const record = expectRecord(value, `${sourceLabel}.workItem`);
  assertAllowedKeys(
    record,
    ["id", "identifier", "title", "description", "labels", "url"],
    `${sourceLabel}.workItem`,
  );

  return {
    id: readOptionalNonEmptyString(record, "id", `${sourceLabel}.workItem`),
    identifier: readOptionalNullableString(
      record,
      "identifier",
      `${sourceLabel}.workItem`,
    ),
    title: readOptionalNonEmptyString(record, "title", `${sourceLabel}.workItem`),
    description: readOptionalNullableString(
      record,
      "description",
      `${sourceLabel}.workItem`,
    ),
    labels: readOptionalStringArray(record, "labels", `${sourceLabel}.workItem`),
    url: readOptionalNullableString(record, "url", `${sourceLabel}.workItem`),
  };
}

function parseArtifactPatch(
  value: unknown,
  sourceLabel: string,
): PromptContextPatch["artifact"] {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const record = expectRecord(value, `${sourceLabel}.artifact`);
  assertAllowedKeys(
    record,
    ["artifactId", "url", "summary"],
    `${sourceLabel}.artifact`,
  );

  return {
    artifactId: expectNonEmptyString(
      record.artifactId,
      `${sourceLabel}.artifact.artifactId`,
    ),
    url: readOptionalNullableString(record, "url", `${sourceLabel}.artifact`),
    summary: readOptionalNullableString(
      record,
      "summary",
      `${sourceLabel}.artifact`,
    ),
  };
}

function parseWorkspacePatch(
  value: unknown,
  sourceLabel: string,
): PromptContextPatch["workspace"] {
  if (value === undefined) {
    return undefined;
  }

  const record = expectRecord(value, `${sourceLabel}.workspace`);
  assertAllowedKeys(
    record,
    [
      "repoRoot",
      "workingDir",
      "mode",
      "assignedBranch",
      "baseBranch",
      "pullRequestUrl",
      "pullRequestMode",
      "writeScope",
    ],
    `${sourceLabel}.workspace`,
  );

  return {
    repoRoot: readOptionalNonEmptyString(
      record,
      "repoRoot",
      `${sourceLabel}.workspace`,
    ),
    workingDir: readOptionalNullableString(
      record,
      "workingDir",
      `${sourceLabel}.workspace`,
    ),
    mode: readOptionalWorkspaceMode(record, "mode", `${sourceLabel}.workspace`),
    assignedBranch: readOptionalNullableString(
      record,
      "assignedBranch",
      `${sourceLabel}.workspace`,
    ),
    baseBranch: readOptionalNullableString(
      record,
      "baseBranch",
      `${sourceLabel}.workspace`,
    ),
    pullRequestUrl: readOptionalNullableString(
      record,
      "pullRequestUrl",
      `${sourceLabel}.workspace`,
    ),
    pullRequestMode: readOptionalNullableString(
      record,
      "pullRequestMode",
      `${sourceLabel}.workspace`,
    ),
    writeScope: readOptionalNullableString(
      record,
      "writeScope",
      `${sourceLabel}.workspace`,
    ),
  };
}

function parseExpectationsPatch(
  value: unknown,
  sourceLabel: string,
): PromptContextPatch["expectations"] {
  if (value === undefined) {
    return undefined;
  }

  const record = expectRecord(value, `${sourceLabel}.expectations`);
  assertAllowedKeys(
    record,
    [
      "expectedOutputs",
      "verificationRequired",
      "requiredRepoChecks",
      "testExpectations",
    ],
    `${sourceLabel}.expectations`,
  );

  return {
    expectedOutputs: readOptionalStringArray(
      record,
      "expectedOutputs",
      `${sourceLabel}.expectations`,
    ),
    verificationRequired: readOptionalBoolean(
      record,
      "verificationRequired",
      `${sourceLabel}.expectations`,
    ),
    requiredRepoChecks: readOptionalStringArray(
      record,
      "requiredRepoChecks",
      `${sourceLabel}.expectations`,
    ),
    testExpectations: readOptionalNullableString(
      record,
      "testExpectations",
      `${sourceLabel}.expectations`,
    ),
  };
}

function parseAttachments(
  value: unknown,
  sourceLabel: string,
): PromptAttachment[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new PromptPreviewError(
      `${sourceLabel}.attachments must be an array when provided.`,
    );
  }

  return value.map((entry, index) => parseAttachment(entry, `${sourceLabel}.attachments[${index}]`));
}

function parseAttachment(value: unknown, pathLabel: string): PromptAttachment {
  const record = expectRecord(value, pathLabel);
  assertAllowedKeys(record, ["kind", "value", "label"], pathLabel);
  const kind = expectNonEmptyString(record.kind, `${pathLabel}.kind`);

  if (!PROMPT_ATTACHMENT_KIND_SET.has(kind)) {
    throw new PromptPreviewError(
      `${pathLabel}.kind must be one of ${PROMPT_ATTACHMENT_KINDS.join(", ")}.`,
    );
  }

  return {
    kind: kind as PromptAttachment["kind"],
    value: expectNonEmptyString(record.value, `${pathLabel}.value`),
    label: readOptionalNullableString(record, "label", pathLabel),
  };
}

function expectRecord(value: unknown, pathLabel: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PromptPreviewError(`${pathLabel} must be a JSON object.`);
  }

  return value as Record<string, unknown>;
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  pathLabel: string,
): void {
  const allowed = new Set(allowedKeys);

  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new PromptPreviewError(
        `${pathLabel} contains an unknown field '${key}'.`,
      );
    }
  }
}

function expectNonEmptyString(value: unknown, pathLabel: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PromptPreviewError(`${pathLabel} must be a non-empty string.`);
  }

  return value;
}

function readOptionalNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  pathLabel: string,
): string | undefined {
  if (!(key in record)) {
    return undefined;
  }

  return expectNonEmptyString(record[key], `${pathLabel}.${key}`);
}

function readOptionalNullableString(
  record: Record<string, unknown>,
  key: string,
  pathLabel: string,
): string | null | undefined {
  if (!(key in record)) {
    return undefined;
  }

  const value = record[key];

  if (value === null) {
    return null;
  }

  return expectNonEmptyString(value, `${pathLabel}.${key}`);
}

function readOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
  pathLabel: string,
): string[] | undefined {
  if (!(key in record)) {
    return undefined;
  }

  const value = record[key];

  if (!Array.isArray(value)) {
    throw new PromptPreviewError(`${pathLabel}.${key} must be an array.`);
  }

  return value.map((entry, index) =>
    expectNonEmptyString(entry, `${pathLabel}.${key}[${index}]`),
  );
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  pathLabel: string,
): boolean | undefined {
  if (!(key in record)) {
    return undefined;
  }

  const value = record[key];

  if (typeof value !== "boolean") {
    throw new PromptPreviewError(`${pathLabel}.${key} must be a boolean.`);
  }

  return value;
}

function readOptionalWorkspaceMode(
  record: Record<string, unknown>,
  key: string,
  pathLabel: string,
): WorkspaceMode | undefined {
  if (!(key in record)) {
    return undefined;
  }

  const value = expectNonEmptyString(record[key], `${pathLabel}.${key}`);

  if (!WORKSPACE_MODE_SET.has(value)) {
    throw new PromptPreviewError(
      `${pathLabel}.${key} must be one of ${WORKSPACE_MODES.join(", ")}.`,
    );
  }

  return value as WorkspaceMode;
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
