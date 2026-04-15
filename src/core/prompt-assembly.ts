import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { resolvePromptSelection } from "../config/prompt-selection.js";
import type {
  LoadedConfig,
  PromptCapabilityContextRequirement,
  PromptCapabilityDefinition,
} from "../config/types.js";
import type {
  ArtifactRecord,
  PromptAttachment,
  PromptEnvelope,
  PromptProvenanceRecord,
  PromptReplayContextRecord,
  PromptSourceKind,
  WorkPhase,
} from "../domain-model.js";

const MISSING_VALUE = "(none)";

export type PromptRole = WorkPhase;

export type PromptAssemblyAddition = {
  label: string;
  markdown: string;
};

export type PromptAssemblyContext = PromptReplayContextRecord;

export type PromptAssemblyRequest = {
  promptPackName?: string;
  role: PromptRole;
  phase: WorkPhase;
  capabilities?: string[];
  experiment?: string | null;
  organizationOverlays?: string[];
  projectOverlays?: string[];
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
  grantedCapabilities: string[];
  provenance: PromptProvenanceRecord;
  resolvedLayers: ResolvedPromptLayer[];
};

type PromptAssemblyConfig = Pick<
  LoadedConfig,
  "activeProfile" | "promptCapabilities" | "promptPacks" | "prompts"
>;

type FileLayerSpec = {
  kind: Extract<
    PromptSourceKind,
    | "base_pack"
    | "invariant"
    | "role_prompt"
    | "phase_prompt"
    | "capability"
    | "overlay"
    | "experiment"
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
  let selection;

  try {
    selection = resolvePromptSelection(config, {
      promptPackName: request.promptPackName,
      experiment: request.experiment,
      organizationOverlays: request.organizationOverlays,
      projectOverlays: request.projectOverlays,
    });
  } catch (error) {
    throw new PromptAssemblyError(
      error instanceof Error ? error.message : "Failed to resolve prompt selection.",
    );
  }

  const { promptPackName, promptPack } = selection;
  const promptRoot = config.prompts.root;
  const requestedCapabilities = dedupeStrings(request.capabilities);
  const unknownCapabilities = requestedCapabilities.filter(
    (capability) => !hasOwn(config.promptCapabilities, capability),
  );
  if (unknownCapabilities.length > 0) {
    throw new PromptAssemblyError(
      `Unknown prompt capabilities requested: ${unknownCapabilities.join(", ")}.`,
    );
  }
  const unavailableCapabilities = requestedCapabilities.filter(
    (capability) => !hasOwn(promptPack.capabilities, capability),
  );

  if (unavailableCapabilities.length > 0) {
    throw new PromptAssemblyError(
      `Prompt pack '${promptPackName}' does not define requested capabilities: ${unavailableCapabilities.join(", ")}.`,
    );
  }

  const capabilityOrder = Object.keys(promptPack.capabilities);
  const resolvedCapabilities = resolveRequestedCapabilities(
    requestedCapabilities,
    capabilityOrder,
    config.promptCapabilities,
  );
  validateCapabilitySelections(resolvedCapabilities, request);

  const systemLayers: FileLayerSpec[] = [];
  systemLayers.push({
    kind: "base_pack",
    path: promptPack.baseSystem,
    ref: createPackRef(promptPackName, promptRoot, promptPack.baseSystem),
  });
  for (const invariantPath of config.prompts.invariants) {
    systemLayers.push({
      kind: "invariant",
      path: invariantPath,
      ref: createInvariantRef(promptRoot, invariantPath),
    });
  }

  const userFileLayers: FileLayerSpec[] = [];

  const rolePath = promptPack.roles[request.role];
  if (rolePath === undefined) {
    throw new PromptAssemblyError(
      `Prompt pack '${promptPackName}' does not define a role prompt for '${request.role}'.`,
    );
  }

  userFileLayers.push({
    kind: "role_prompt",
    path: rolePath,
    ref: createPackRef(promptPackName, promptRoot, rolePath),
  });

  const phasePath = promptPack.phases[request.phase];
  if (phasePath !== undefined) {
    userFileLayers.push({
      kind: "phase_prompt",
      path: phasePath,
      ref: createPackRef(promptPackName, promptRoot, phasePath),
    });
  }

  for (const capability of resolvedCapabilities) {
    const capabilityPath = promptPack.capabilities[capability.name];
    userFileLayers.push({
      kind: "capability",
      path: capabilityPath,
      ref: createPackRef(promptPackName, promptRoot, capabilityPath),
    });
  }

  for (const overlay of [
    ...selection.overlays.organization,
    ...selection.overlays.project,
  ]) {
    userFileLayers.push({
      kind: "overlay",
      path: overlay.assetPath,
      ref: createPackRef(promptPackName, promptRoot, overlay.assetPath),
    });
  }

  const experimentLayer =
    selection.experiment === null
      ? null
      : {
          kind: "experiment" as const,
          path: selection.experiment.assetPath,
          ref: createPackRef(
            promptPackName,
            promptRoot,
            selection.experiment.assetPath,
          ),
        };

  const fileLayersByPath = new Map<string, string>();
  await Promise.all(
    [
      ...systemLayers,
      ...userFileLayers,
      ...(experimentLayer === null ? [] : [experimentLayer]),
    ].map(async (layer) => {
      const contents = normalizePromptText(await readFile(layer.path, "utf8"));
      fileLayersByPath.set(layer.path, contents);
    }),
  );

  const resolvedLayers: ResolvedPromptLayer[] = [];
  const userLayers: RenderedLayer[] = [];
  const systemPromptLayers: string[] = [];

  for (const fileLayer of systemLayers) {
    const contents = fileLayersByPath.get(fileLayer.path);

    if (contents === undefined || contents.length === 0) {
      throw new PromptAssemblyError(
        `Prompt layer '${fileLayer.path}' resolved to empty content.`,
      );
    }

    systemPromptLayers.push(contents);
    resolvedLayers.push(
      createResolvedLayer(
        fileLayer.kind,
        fileLayer.ref,
        contents,
        fileLayer.path,
      ),
    );
  }

  for (const fileLayer of userFileLayers) {
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
    content: renderRunContext(
      request.context,
      request.phase,
      resolvedCapabilities.map((capability) => capability.name),
    ),
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

  const systemPrompt = systemPromptLayers.join("\n\n");
  const userPrompt = userLayers.map((layer) => layer.content).join("\n\n");
  const attachments = buildAttachments(request.context);
  const prompt: PromptEnvelope = {
    contractId: `orqestrate/${promptPackName}/${request.role}/${request.phase}/v2`,
    systemPrompt,
    userPrompt,
    attachments,
    sources: resolvedLayers.map((layer) => ({
      kind: layer.kind,
      ref: layer.ref,
    })),
    digests: {
      system: hashPromptText(systemPrompt),
      user: hashPromptText(userPrompt),
    },
  };
  const provenance: PromptProvenanceRecord = {
    selection: {
      promptPackName,
      capabilityNames: resolvedCapabilities.map((capability) => capability.name),
      organizationOverlayNames: selection.overlays.organization.map(
        (overlay) => overlay.name,
      ),
      projectOverlayNames: selection.overlays.project.map((overlay) => overlay.name),
      experimentName: selection.experiment?.name ?? null,
    },
    sources: resolvedLayers.map((layer) => ({
      kind: layer.kind,
      ref: layer.ref,
      digest: layer.digest,
    })),
    rendered: {
      systemPromptLength: systemPrompt.length,
      userPromptLength: userPrompt.length,
      attachmentKinds: collectAttachmentKinds(attachments),
      attachmentCount: attachments.length,
    },
  };

  return {
    prompt,
    grantedCapabilities: resolvedCapabilities.map((capability) => capability.name),
    provenance,
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

function collectAttachmentKinds(
  attachments: readonly PromptAttachment[],
): PromptAttachment["kind"][] {
  const seen = new Set<PromptAttachment["kind"]>();
  const attachmentKinds: PromptAttachment["kind"][] = [];

  for (const attachment of attachments) {
    if (seen.has(attachment.kind)) {
      continue;
    }

    seen.add(attachment.kind);
    attachmentKinds.push(attachment.kind);
  }

  return attachmentKinds;
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

function renderRunContext(
  context: PromptAssemblyContext,
  phase: WorkPhase,
  authorizedCapabilities: readonly string[],
): string {
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
    `Authorized capabilities: ${formatList(authorizedCapabilities)}`,
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

function createInvariantRef(promptRoot: string, assetPath: string): string {
  const relativePath = toPosixPath(path.relative(promptRoot, assetPath));
  return `prompt-invariant:${relativePath}`;
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

type ResolvedCapability = {
  name: string;
  definition: PromptCapabilityDefinition;
};

function resolveRequestedCapabilities(
  requestedCapabilities: readonly string[],
  capabilityOrder: readonly string[],
  capabilityRegistry: Record<string, PromptCapabilityDefinition>,
): ResolvedCapability[] {
  return capabilityOrder
    .filter((capability) => requestedCapabilities.includes(capability))
    .map((capability) => ({
      name: capability,
      definition: capabilityRegistry[capability],
    }));
}

function validateCapabilitySelections(
  capabilities: readonly ResolvedCapability[],
  request: PromptAssemblyRequest,
): void {
  const requestedCapabilityNames = capabilities.map((capability) => capability.name);

  for (const capability of capabilities) {
    validateCapabilityPhase(capability, request.phase);
    validateCapabilityRole(capability, request.role);
    validateCapabilityContext(capability, request.context);
    validateCapabilityRequirements(capability, requestedCapabilityNames);
  }

  validateCapabilityConflicts(capabilities);
}

function validateCapabilityPhase(
  capability: ResolvedCapability,
  phase: WorkPhase,
): void {
  const allowedPhases = capability.definition.allowedPhases;
  if (
    allowedPhases.length > 0 &&
    !allowedPhases.includes(phase)
  ) {
    throw new PromptAssemblyError(
      `Prompt capability '${capability.name}' is not allowed in phase '${phase}'.`,
    );
  }
}

function validateCapabilityRole(
  capability: ResolvedCapability,
  role: PromptRole,
): void {
  const allowedRoles = capability.definition.allowedRoles;
  if (allowedRoles.length > 0 && !allowedRoles.includes(role)) {
    throw new PromptAssemblyError(
      `Prompt capability '${capability.name}' is not allowed for role '${role}'.`,
    );
  }
}

function validateCapabilityContext(
  capability: ResolvedCapability,
  context: PromptAssemblyContext,
): void {
  const missingRequirements = capability.definition.requiredContext.filter(
    (requirement) => !hasCapabilityContextRequirement(requirement, context),
  );

  if (missingRequirements.length > 0) {
    throw new PromptAssemblyError(
      `Prompt capability '${capability.name}' requires context: ${missingRequirements.join(", ")}.`,
    );
  }
}

function validateCapabilityRequirements(
  capability: ResolvedCapability,
  requestedCapabilities: readonly string[],
): void {
  const missingCapabilities = capability.definition.requires.filter(
    (requiredCapability) => !requestedCapabilities.includes(requiredCapability),
  );

  if (missingCapabilities.length > 0) {
    throw new PromptAssemblyError(
      `Prompt capability '${capability.name}' requires capabilities: ${missingCapabilities.join(", ")}.`,
    );
  }
}

function validateCapabilityConflicts(
  capabilities: readonly ResolvedCapability[],
): void {
  const requested = new Set(capabilities.map((capability) => capability.name));
  const seenPairs = new Set<string>();

  for (const capability of capabilities) {
    for (const conflictingCapability of capability.definition.conflictsWith) {
      if (!requested.has(conflictingCapability)) {
        continue;
      }

      const pairKey = [capability.name, conflictingCapability].sort().join("\u0000");
      if (seenPairs.has(pairKey)) {
        continue;
      }

      seenPairs.add(pairKey);
      throw new PromptAssemblyError(
        `Prompt capabilities conflict: ${capability.name} conflicts with ${conflictingCapability}.`,
      );
    }
  }
}

function hasCapabilityContextRequirement(
  requirement: PromptCapabilityContextRequirement,
  context: PromptAssemblyContext,
): boolean {
  switch (requirement) {
    case "pull_request_url":
      return hasMeaningfulText(context.workspace.pullRequestUrl);
    case "assigned_branch":
      return hasMeaningfulText(context.workspace.assignedBranch);
    case "write_scope":
      return hasMeaningfulText(context.workspace.writeScope);
    case "artifact":
      return context.artifact !== undefined && context.artifact !== null;
  }
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
