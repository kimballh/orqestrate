import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { LoadedConfig } from "../config/types.js";
import type {
  ArtifactRecord,
  PromptAttachment,
  PromptEnvelope,
  PromptSourceKind,
  WorkItemRecord,
  WorkPhase,
  WorkspaceMode,
} from "../domain-model.js";

const CONFIGURED_OVERLAY_GROUPS = ["organization", "project"] as const;
const MISSING_VALUE = "(none)";

export type PromptRole = WorkPhase;

export type PromptAssemblyAddition = {
  label: string;
  markdown: string;
};

export type PromptAssemblyContext = {
  runId?: string | null;
  workItem: Pick<
    WorkItemRecord,
    "id" | "identifier" | "title" | "description" | "labels" | "url"
  >;
  artifact?: Pick<ArtifactRecord, "artifactId" | "url" | "summary"> | null;
  workspace: {
    repoRoot: string;
    workingDir?: string | null;
    mode: WorkspaceMode;
    assignedBranch?: string | null;
    baseBranch?: string | null;
    pullRequestUrl?: string | null;
    pullRequestMode?: string | null;
    writeScope?: string | null;
  };
  expectations: {
    expectedOutputs?: string[];
    verificationRequired?: boolean;
    requiredRepoChecks?: string[];
    testExpectations?: string | null;
    authorizedCapabilities?: string[];
  };
  operatorNote?: string | null;
  additionalContext?: string | null;
  attachments?: PromptAttachment[];
};

export type PromptAssemblyRequest = {
  promptPackName?: string;
  role: PromptRole;
  phase: WorkPhase;
  capabilities?: string[];
  experiment?: string | null;
  runAdditions?: PromptAssemblyAddition[];
  context: PromptAssemblyContext;
};

export type ResolvedPromptLayer = {
  kind: PromptSourceKind;
  ref: string;
  path?: string;
  digest: string;
};

export type PromptAssemblyResult = {
  prompt: PromptEnvelope;
  resolvedLayers: ResolvedPromptLayer[];
};

type PromptAssemblyConfig = Pick<
  LoadedConfig,
  "activeProfile" | "promptPacks" | "prompts"
>;

type FileLayerSpec = {
  kind: Extract<
    PromptSourceKind,
    "base_pack" | "role_prompt" | "phase_prompt" | "capability" | "overlay" | "experiment"
  >;
  path: string;
  ref: string;
};

type RenderedLayer = {
  kind: PromptSourceKind;
  ref: string;
  content: string;
  path?: string;
};

export class PromptAssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptAssemblyError";
  }
}

export async function assemblePrompt(
  config: PromptAssemblyConfig,
  request: PromptAssemblyRequest,
): Promise<PromptAssemblyResult> {
  const promptPackName =
    request.promptPackName ?? config.activeProfile.promptPackName;
  const promptPack =
    config.promptPacks[promptPackName] ??
    (promptPackName === config.activeProfile.promptPackName
      ? config.activeProfile.promptPack
      : undefined);

  if (promptPack === undefined) {
    throw new PromptAssemblyError(
      `Prompt pack '${promptPackName}' is not defined in the loaded config.`,
    );
  }

  const promptRoot = config.prompts.root;
  const requestedCapabilities = dedupeStrings(request.capabilities);
  const capabilityOrder = Object.keys(promptPack.capabilities);
  const unknownCapabilities = requestedCapabilities.filter(
    (capability) => !hasOwn(promptPack.capabilities, capability),
  );

  if (unknownCapabilities.length > 0) {
    throw new PromptAssemblyError(
      `Unknown prompt capabilities requested: ${unknownCapabilities.join(", ")}.`,
    );
  }

  if (
    request.experiment !== undefined &&
    request.experiment !== null &&
    !hasOwn(promptPack.experiments, request.experiment)
  ) {
    throw new PromptAssemblyError(
      `Unknown prompt experiment '${request.experiment}' requested.`,
    );
  }

  const fileLayers: FileLayerSpec[] = [];
  fileLayers.push({
    kind: "base_pack",
    path: promptPack.baseSystem,
    ref: createPackRef(promptPackName, promptRoot, promptPack.baseSystem),
  });

  const rolePath = promptPack.roles[request.role];
  if (rolePath === undefined) {
    throw new PromptAssemblyError(
      `Prompt pack '${promptPackName}' does not define a role prompt for '${request.role}'.`,
    );
  }

  fileLayers.push({
    kind: "role_prompt",
    path: rolePath,
    ref: createPackRef(promptPackName, promptRoot, rolePath),
  });

  const phasePath = promptPack.phases[request.phase];
  if (phasePath !== undefined) {
    fileLayers.push({
      kind: "phase_prompt",
      path: phasePath,
      ref: createPackRef(promptPackName, promptRoot, phasePath),
    });
  }

  for (const capability of capabilityOrder) {
    if (!requestedCapabilities.includes(capability)) {
      continue;
    }

    const capabilityPath = promptPack.capabilities[capability];
    fileLayers.push({
      kind: "capability",
      path: capabilityPath,
      ref: createPackRef(promptPackName, promptRoot, capabilityPath),
    });
  }

  for (const overlayGroup of CONFIGURED_OVERLAY_GROUPS) {
    const overlayPaths = promptPack.overlays[overlayGroup] ?? [];

    for (const overlayPath of overlayPaths) {
      fileLayers.push({
        kind: "overlay",
        path: overlayPath,
        ref: createPackRef(promptPackName, promptRoot, overlayPath),
      });
    }
  }

  const experimentLayer =
    request.experiment === undefined || request.experiment === null
      ? null
      : {
          kind: "experiment" as const,
          path: promptPack.experiments[request.experiment],
          ref: createPackRef(
            promptPackName,
            promptRoot,
            promptPack.experiments[request.experiment],
          ),
        };

  const fileLayersByPath = new Map<string, string>();
  await Promise.all(
    [...fileLayers, ...(experimentLayer === null ? [] : [experimentLayer])].map(
      async (layer) => {
      const contents = normalizePromptText(await readFile(layer.path, "utf8"));
      fileLayersByPath.set(layer.path, contents);
      },
    ),
  );

  const baseLayerSpec = fileLayers[0];
  const systemPrompt = fileLayersByPath.get(baseLayerSpec.path);

  if (systemPrompt === undefined || systemPrompt.length === 0) {
    throw new PromptAssemblyError(
      `Prompt pack '${promptPackName}' base system prompt '${baseLayerSpec.path}' is empty.`,
    );
  }

  const resolvedLayers: ResolvedPromptLayer[] = [];
  const userLayers: RenderedLayer[] = [];

  resolvedLayers.push(
    createResolvedLayer(
      baseLayerSpec.kind,
      baseLayerSpec.ref,
      systemPrompt,
      baseLayerSpec.path,
    ),
  );

  for (const fileLayer of fileLayers.slice(1)) {
    const contents = fileLayersByPath.get(fileLayer.path);

    if (contents === undefined || contents.length === 0) {
      throw new PromptAssemblyError(
        `Prompt layer '${fileLayer.path}' resolved to empty content.`,
      );
    }

    userLayers.push({
      kind: fileLayer.kind,
      ref: fileLayer.ref,
      path: fileLayer.path,
      content: contents,
    });
  }

  for (const addition of request.runAdditions ?? []) {
    const renderedAddition = renderRunAddition(addition);
    if (renderedAddition === null) {
      continue;
    }

    userLayers.push({
      kind: "overlay",
      ref: `run-addition:${slugifyLabel(addition.label)}`,
      content: renderedAddition,
    });
  }

  if (experimentLayer !== null) {
    const contents = fileLayersByPath.get(experimentLayer.path);

    if (contents === undefined || contents.length === 0) {
      throw new PromptAssemblyError(
        `Prompt layer '${experimentLayer.path}' resolved to empty content.`,
      );
    }

    userLayers.push({
      kind: experimentLayer.kind,
      ref: experimentLayer.ref,
      path: experimentLayer.path,
      content: contents,
    });
  }

  userLayers.push({
    kind: "system_generated",
    ref: "run-context",
    content: renderRunContext(request),
  });

  if (request.context.artifact !== undefined && request.context.artifact !== null) {
    const artifactContext = renderArtifactContext(request.context.artifact);
    if (artifactContext !== null) {
      userLayers.push({
        kind: "artifact",
        ref: `artifact:${request.context.artifact.artifactId}`,
        content: artifactContext,
      });
    }
  }

  if (hasMeaningfulText(request.context.operatorNote)) {
    userLayers.push({
      kind: "operator_note",
      ref: "operator-note",
      content: renderSimpleSection("Operator Note", request.context.operatorNote ?? ""),
    });
  }

  if (hasMeaningfulText(request.context.additionalContext)) {
    userLayers.push({
      kind: "system_generated",
      ref: "additional-context",
      content: renderSimpleSection(
        "Additional Context",
        request.context.additionalContext ?? "",
      ),
    });
  }

  for (const layer of userLayers) {
    resolvedLayers.push(
      createResolvedLayer(layer.kind, layer.ref, layer.content, layer.path),
    );
  }

  const prompt: PromptEnvelope = {
    contractId: `orqestrate/${promptPackName}/${request.role}/${request.phase}/v1`,
    systemPrompt,
    userPrompt: userLayers.map((layer) => layer.content).join("\n\n"),
    attachments: buildAttachments(request.context),
    sources: resolvedLayers.map((layer) => ({
      kind: layer.kind,
      ref: layer.ref,
    })),
    digests: {
      system: hashPromptText(systemPrompt),
      user: hashPromptText(userLayers.map((layer) => layer.content).join("\n\n")),
    },
  };

  return {
    prompt,
    resolvedLayers,
  };
}

function createResolvedLayer(
  kind: PromptSourceKind,
  ref: string,
  content: string,
  resolvedPath?: string,
): ResolvedPromptLayer {
  return {
    kind,
    ref,
    path: resolvedPath,
    digest: hashPromptText(content),
  };
}

function buildAttachments(context: PromptAssemblyContext): PromptAttachment[] {
  const attachments: PromptAttachment[] = [];

  if (hasMeaningfulText(context.workItem.url)) {
    attachments.push({
      kind: "planning_url",
      value: context.workItem.url ?? "",
      label: "Planning issue",
    });
  }

  if (context.artifact?.url && hasMeaningfulText(context.artifact.url)) {
    attachments.push({
      kind: "artifact_url",
      value: context.artifact.url,
      label: "Issue artifact",
    });
  }

  for (const attachment of context.attachments ?? []) {
    attachments.push(attachment);
  }

  const seen = new Set<string>();
  const deduped: PromptAttachment[] = [];

  for (const attachment of attachments) {
    const key = `${attachment.kind}\u0000${attachment.value}\u0000${attachment.label ?? ""}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(attachment);
  }

  return deduped;
}

function renderRunAddition(addition: PromptAssemblyAddition): string | null {
  const heading = normalizePromptText(addition.label);
  const body = normalizePromptText(addition.markdown);

  if (body.length === 0) {
    return null;
  }

  const sectionTitle = heading.length > 0 ? heading : "Run Addition";
  return `## ${sectionTitle}\n${body}`;
}

function renderRunContext(request: PromptAssemblyRequest): string {
  const { context, phase } = request;
  const lines = [
    "## Run Context",
    `Run ID: ${formatScalar(context.runId)}`,
    `Work item ID: ${context.workItem.id}`,
    `Work item identifier: ${formatScalar(context.workItem.identifier)}`,
    `Title: ${context.workItem.title}`,
    `Phase: ${phase}`,
    `Labels: ${formatList(context.workItem.labels)}`,
    `Work item URL: ${formatScalar(context.workItem.url)}`,
    `Repository root: ${context.workspace.repoRoot}`,
    `Working directory: ${formatScalar(context.workspace.workingDir)}`,
    `Workspace mode: ${context.workspace.mode}`,
    `Assigned branch: ${formatScalar(context.workspace.assignedBranch)}`,
    `Base branch: ${formatScalar(context.workspace.baseBranch)}`,
    `Pull request URL: ${formatScalar(context.workspace.pullRequestUrl)}`,
    `Pull request mode: ${formatScalar(context.workspace.pullRequestMode)}`,
    `Write scope: ${formatScalar(context.workspace.writeScope)}`,
    `Expected outputs: ${formatList(context.expectations.expectedOutputs)}`,
    `Verification required: ${formatBoolean(
      context.expectations.verificationRequired,
    )}`,
    `Required repo checks: ${formatList(context.expectations.requiredRepoChecks)}`,
    `Test expectations: ${formatScalar(context.expectations.testExpectations)}`,
    `Authorized capabilities: ${formatList(
      context.expectations.authorizedCapabilities,
    )}`,
  ];

  if (hasMeaningfulText(context.workItem.description)) {
    lines.push("", "### Work Item Description", context.workItem.description ?? "");
  }

  return normalizePromptText(lines.join("\n"));
}

function renderArtifactContext(
  artifact: Pick<ArtifactRecord, "artifactId" | "url" | "summary">,
): string | null {
  const details: string[] = [];

  if (hasMeaningfulText(artifact.url)) {
    details.push(`Artifact URL: ${artifact.url}`);
  }

  if (hasMeaningfulText(artifact.summary)) {
    details.push("", "Summary:", artifact.summary ?? "");
  }

  if (details.length === 0) {
    return null;
  }

  return normalizePromptText(
    ["## Artifact Context", `Artifact ID: ${artifact.artifactId}`, ...details].join(
      "\n",
    ),
  );
}

function renderSimpleSection(title: string, body: string): string {
  return normalizePromptText(`## ${title}\n${body}`);
}

function createPackRef(
  promptPackName: string,
  promptRoot: string,
  assetPath: string,
): string {
  const relativePath = toPosixPath(path.relative(promptRoot, assetPath));
  return `prompt-pack:${promptPackName}/${relativePath}`;
}

function normalizePromptText(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function hashPromptText(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function dedupeStrings(values: readonly string[] | undefined): string[] {
  if (values === undefined) {
    return [];
  }

  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}

function formatScalar(value: string | null | undefined): string {
  if (!hasMeaningfulText(value)) {
    return MISSING_VALUE;
  }

  return normalizePromptText(value ?? "");
}

function formatList(values: readonly string[] | undefined): string {
  if (values === undefined || values.length === 0) {
    return MISSING_VALUE;
  }

  return values.join(", ");
}

function formatBoolean(value: boolean | undefined): string {
  if (value === undefined) {
    return MISSING_VALUE;
  }

  return value ? "yes" : "no";
}

function hasMeaningfulText(value: string | null | undefined): boolean {
  return value !== undefined && value !== null && normalizePromptText(value).length > 0;
}

function slugifyLabel(label: string): string {
  const normalized = normalizePromptText(label).toLowerCase();

  if (normalized.length === 0) {
    return "inline";
  }

  const slug = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "inline";
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}
