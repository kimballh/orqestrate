import path from "node:path";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";

import type { ContextLocalFilesProviderConfig } from "../../config/types.js";
import type {
  ArtifactRecord,
  RunLedgerRecord,
  WorkItemRecord,
  WorkPhase,
} from "../../domain-model.js";

import type {
  AppendEvidenceInput,
  ContextBundle,
  ContextReference,
  CreateRunLedgerEntryInput,
  EnsureArtifactInput,
  FinalizeRunLedgerEntryInput,
  LoadContextBundleInput,
  WritePhaseArtifactInput,
} from "../../core/context-backend.js";

import { UnimplementedContextBackend } from "./unimplemented-context-backend.js";

const ARTIFACT_DIRECTORY = "artifacts";
const RUN_DIRECTORY = "runs";
const EVIDENCE_DIRECTORY = "evidence";
const ARTIFACT_TEMPLATE_KEYS = ["artifact_template", "artifact"] as const;
const EVIDENCE_TEMPLATE_KEYS = [
  "run_template",
  "evidence_template",
  "evidence",
] as const;
const VERIFICATION_SECTION_HEADING = "Verification";
const VERIFICATION_SECTION_START = "<!-- orqestrate:verification:start -->";
const VERIFICATION_SECTION_END = "<!-- orqestrate:verification:end -->";
const SECTION_DEFINITIONS = [
  {
    phase: "design",
    heading: "Design",
    placeholder: "Pending design notes.",
  },
  {
    phase: "plan",
    heading: "Plan",
    placeholder: "Pending implementation plan.",
  },
  {
    phase: "implement",
    heading: "Implementation Notes",
    placeholder: "Pending implementation notes.",
  },
  {
    phase: "review",
    heading: "Review",
    placeholder: "Pending review notes.",
  },
  {
    phase: "merge",
    heading: "Merge",
    placeholder: "Pending merge notes.",
  },
] as const satisfies ReadonlyArray<{
  phase: WorkPhase;
  heading: string;
  placeholder: string;
}>;
const RECENT_RUN_LIMIT = 3;

type ArtifactPaths = {
  artifactMarkdownPath: string;
  artifactMetadataPath: string;
  workItemKey: string;
};

type TemplateVariables = Record<string, string>;

export class LocalFilesContextBackend extends UnimplementedContextBackend<ContextLocalFilesProviderConfig> {
  async validateConfig(): Promise<void> {
    await mkdir(this.config.root, { recursive: true });
    await Promise.all([
      mkdir(this.artifactsDir, { recursive: true }),
      mkdir(this.runsDir, { recursive: true }),
      mkdir(this.evidenceDir, { recursive: true }),
    ]);

    for (const templatePath of Object.values(this.config.templates)) {
      const templateStats = await stat(templatePath).catch(() => null);

      if (templateStats === null || !templateStats.isFile()) {
        throw new Error(`Template file '${templatePath}' does not exist.`);
      }
    }
  }

  async ensureArtifact(input: EnsureArtifactInput): Promise<ArtifactRecord> {
    await this.validateConfig();

    const paths = this.getArtifactPaths(input.workItem.id);
    const existingArtifact = await this.readArtifactRecord(paths.artifactMetadataPath);

    if (existingArtifact !== null) {
      const artifactStats = await stat(paths.artifactMarkdownPath).catch(() => null);

      if (artifactStats === null) {
        await this.writeArtifactMarkdown(input.workItem, paths.artifactMarkdownPath);
      }

      return existingArtifact;
    }

    const markdownStats = await stat(paths.artifactMarkdownPath).catch(() => null);

    if (markdownStats === null) {
      await this.writeArtifactMarkdown(input.workItem, paths.artifactMarkdownPath);
    }

    const now = createTimestamp();
    const artifactRecord: ArtifactRecord = {
      artifactId: `local-files:${paths.workItemKey}`,
      workItemId: input.workItem.id,
      title: buildArtifactTitle(input.workItem),
      phase: "none",
      state: "draft",
      url: paths.artifactMarkdownPath,
      summary: null,
      designReady: false,
      planReady: false,
      implementationNotesPresent: false,
      reviewSummaryPresent: false,
      verificationEvidencePresent: false,
      updatedAt: now,
      createdAt: now,
    };

    await this.writeArtifactRecord(paths.artifactMetadataPath, artifactRecord);

    return artifactRecord;
  }

  async getArtifactByWorkItemId(
    workItemId: string,
  ): Promise<ArtifactRecord | null> {
    const paths = this.getArtifactPaths(workItemId);
    return this.readArtifactRecord(paths.artifactMetadataPath);
  }

  async loadContextBundle(
    input: LoadContextBundleInput,
  ): Promise<ContextBundle> {
    const artifact =
      input.artifact ??
      (await this.getArtifactByWorkItemId(input.workItem.id));
    const references: ContextReference[] = [];
    const contextParts: string[] = [];

    if (artifact?.url !== undefined && artifact.url !== null) {
      const artifactBody = await readFile(artifact.url, "utf8").catch(() => null);

      if (artifactBody !== null) {
        contextParts.push(artifactBody.trimEnd());
        references.push({
          kind: "artifact",
          title: artifact.title,
          url: artifact.url,
        });
      }
    }

    const recentRuns = await this.loadRecentRunsForWorkItem(input.workItem.id);

    if (recentRuns.length > 0) {
      contextParts.push(renderRunHistoryDigest(recentRuns));
    }

    for (const run of recentRuns) {
      references.push({
        kind: "run_ledger",
        title: `Run ${run.runId} (${run.status})`,
        url: run.url ?? this.getRunPath(run.runId),
      });

      const evidencePath = this.getEvidencePath(run.runId);
      const evidenceStats = await stat(evidencePath).catch(() => null);

      if (evidenceStats !== null) {
        references.push({
          kind: "evidence",
          title: `Evidence ${run.runId}`,
          url: evidencePath,
        });
      }
    }

    return {
      artifact,
      contextText: contextParts.filter(Boolean).join("\n\n").trim(),
      references,
    };
  }

  async writePhaseArtifact(
    input: WritePhaseArtifactInput,
  ): Promise<ArtifactRecord> {
    await this.validateConfig();

    const paths = this.getArtifactPaths(input.workItem.id);
    const ensuredArtifact = await this.ensureArtifact({ workItem: input.workItem });
    const currentMarkdown =
      (await readFile(paths.artifactMarkdownPath, "utf8").catch(() => null)) ??
      (await this.renderArtifactDocument(input.workItem));
    const sectionDefinition = getSectionDefinition(input.phase);

    const nextMarkdown = upsertManagedSection(
      currentMarkdown,
      input.phase,
      sectionDefinition.heading,
      input.content.trim(),
    );

    await writeFile(paths.artifactMarkdownPath, `${nextMarkdown.trimEnd()}\n`, "utf8");

    const now = createTimestamp();
    const nextArtifact = applyPhaseMetadataUpdate(ensuredArtifact, input.phase, {
      summary:
        input.summary === undefined ? ensuredArtifact.summary ?? null : input.summary,
      updatedAt: now,
    });

    await this.writeArtifactRecord(paths.artifactMetadataPath, nextArtifact);

    return nextArtifact;
  }

  async createRunLedgerEntry(
    input: CreateRunLedgerEntryInput,
  ): Promise<RunLedgerRecord> {
    await this.validateConfig();

    const runPath = this.getRunPath(input.runId);
    const existingRun = await this.readRunLedgerRecord(runPath);

    if (existingRun !== null) {
      throw new Error(`Run ledger '${input.runId}' already exists.`);
    }

    const now = createTimestamp();
    const artifact = await this.getArtifactByWorkItemId(input.workItem.id);
    const runLedger: RunLedgerRecord = {
      runId: input.runId,
      workItemId: input.workItem.id,
      artifactId: artifact?.artifactId ?? null,
      phase: input.phase,
      status: input.status,
      summary: null,
      verification: null,
      error: null,
      startedAt: now,
      endedAt: null,
      url: runPath,
      updatedAt: now,
    };

    await this.writeRunLedgerRecord(runPath, runLedger);

    return runLedger;
  }

  async finalizeRunLedgerEntry(
    input: FinalizeRunLedgerEntryInput,
  ): Promise<RunLedgerRecord> {
    const runPath = this.getRunPath(input.runId);
    const currentRun = await this.readRunLedgerRecord(runPath);

    if (currentRun === null) {
      throw new Error(`Run ledger '${input.runId}' does not exist.`);
    }

    const now = createTimestamp();
    const nextRun: RunLedgerRecord = {
      ...currentRun,
      status: input.status,
      summary: input.summary === undefined ? currentRun.summary ?? null : input.summary,
      error: input.error === undefined ? currentRun.error ?? null : input.error,
      endedAt: now,
      updatedAt: now,
      url: runPath,
    };

    await this.writeRunLedgerRecord(runPath, nextRun);

    return nextRun;
  }

  async appendEvidence(input: AppendEvidenceInput): Promise<void> {
    await this.validateConfig();

    const evidencePath = this.getEvidencePath(input.runId);
    const evidenceStats = await stat(evidencePath).catch(() => null);

    if (evidenceStats === null) {
      const initialContent = await this.renderInitialEvidenceDocument(input);
      await writeFile(evidencePath, `${initialContent.trimEnd()}\n\n`, "utf8");
    }

    const timestamp = createTimestamp();
    const evidenceBlock = [
      `## ${timestamp} - ${input.section}`,
      "",
      input.content.trim(),
      "",
    ].join("\n");

    const existingEvidence = await readFile(evidencePath, "utf8");
    await writeFile(
      evidencePath,
      `${existingEvidence.trimEnd()}\n\n${evidenceBlock}`,
      "utf8",
    );

    const paths = this.getArtifactPaths(input.workItemId);
    const artifact = await this.readArtifactRecord(paths.artifactMetadataPath);

    if (artifact !== null) {
      const artifactMarkdown =
        (await readFile(paths.artifactMarkdownPath, "utf8").catch(() => null)) ?? null;
      const nextArtifact: ArtifactRecord = {
        ...artifact,
        verificationEvidencePresent: true,
        updatedAt: timestamp,
      };

      if (artifactMarkdown !== null) {
        const verificationSummary = renderVerificationSection({
          evidencePath,
          latestSection: input.section,
          latestTimestamp: timestamp,
        });
        const nextMarkdown = upsertSectionBody(
          artifactMarkdown,
          VERIFICATION_SECTION_HEADING,
          verificationSummary,
          {
            startMarker: VERIFICATION_SECTION_START,
            endMarker: VERIFICATION_SECTION_END,
            nextHeading: "# Decision Log",
          },
        );

        await writeFile(paths.artifactMarkdownPath, `${nextMarkdown.trimEnd()}\n`, "utf8");
      }

      await this.writeArtifactRecord(paths.artifactMetadataPath, nextArtifact);
    }
  }

  private get artifactsDir(): string {
    return path.join(this.config.root, ARTIFACT_DIRECTORY);
  }

  private get runsDir(): string {
    return path.join(this.config.root, RUN_DIRECTORY);
  }

  private get evidenceDir(): string {
    return path.join(this.config.root, EVIDENCE_DIRECTORY);
  }

  private getArtifactPaths(workItemId: string): ArtifactPaths {
    const workItemKey = toWorkItemKey(workItemId);

    return {
      workItemKey,
      artifactMarkdownPath: path.join(this.artifactsDir, `${workItemKey}.md`),
      artifactMetadataPath: path.join(this.artifactsDir, `${workItemKey}.json`),
    };
  }

  private getRunPath(runId: string): string {
    assertSafeRunId(runId);
    return path.join(this.runsDir, `${runId}.json`);
  }

  private getEvidencePath(runId: string): string {
    assertSafeRunId(runId);
    return path.join(this.evidenceDir, `${runId}.md`);
  }

  private async writeArtifactMarkdown(
    workItem: WorkItemRecord,
    artifactMarkdownPath: string,
  ): Promise<void> {
    const markdown = await this.renderArtifactDocument(workItem);
    await writeFile(artifactMarkdownPath, `${markdown.trimEnd()}\n`, "utf8");
  }

  private async renderArtifactDocument(workItem: WorkItemRecord): Promise<string> {
    const contextTemplatePath = firstConfiguredTemplatePath(
      this.config.templates,
      ARTIFACT_TEMPLATE_KEYS,
    );
    const contextContent =
      contextTemplatePath === undefined
        ? renderDefaultContextSection(workItem)
        : renderTemplate(
            await readFile(contextTemplatePath, "utf8"),
            createArtifactTemplateVariables(workItem),
          ).trim();
    const createdAt = createTimestamp();

    return [
      "# Context",
      "",
      contextContent,
      "",
      ...SECTION_DEFINITIONS.flatMap((section) => [
        `# ${section.heading}`,
        "",
        startMarker(section.phase),
        section.placeholder,
        endMarker(section.phase),
        "",
      ]),
      `# ${VERIFICATION_SECTION_HEADING}`,
      "",
      VERIFICATION_SECTION_START,
      "No verification evidence captured yet.",
      VERIFICATION_SECTION_END,
      "",
      "# Decision Log",
      "",
      `- Artifact created at ${createdAt}`,
    ].join("\n");
  }

  private async renderInitialEvidenceDocument(
    input: AppendEvidenceInput,
  ): Promise<string> {
    const evidenceTemplatePath = firstConfiguredTemplatePath(
      this.config.templates,
      EVIDENCE_TEMPLATE_KEYS,
    );

    if (evidenceTemplatePath !== undefined) {
      const template = await readFile(evidenceTemplatePath, "utf8");
      return renderTemplate(template, {
        createdAt: createTimestamp(),
        runId: input.runId,
        workItemId: input.workItemId,
      }).trim();
    }

    return [
      "# Evidence",
      "",
      `- Run ID: \`${input.runId}\``,
      `- Work Item ID: \`${input.workItemId}\``,
      "",
    ].join("\n");
  }

  private async readArtifactRecord(
    artifactMetadataPath: string,
  ): Promise<ArtifactRecord | null> {
    return readJsonFile<ArtifactRecord>(artifactMetadataPath);
  }

  private async writeArtifactRecord(
    artifactMetadataPath: string,
    artifact: ArtifactRecord,
  ): Promise<void> {
    await writeJsonFile(artifactMetadataPath, artifact);
  }

  private async readRunLedgerRecord(
    runPath: string,
  ): Promise<RunLedgerRecord | null> {
    return readJsonFile<RunLedgerRecord>(runPath);
  }

  private async writeRunLedgerRecord(
    runPath: string,
    runLedger: RunLedgerRecord,
  ): Promise<void> {
    await writeJsonFile(runPath, runLedger);
  }

  private async loadRecentRunsForWorkItem(
    workItemId: string,
  ): Promise<RunLedgerRecord[]> {
    const runFiles = await readdir(this.runsDir).catch(() => []);
    const relevantRuns: RunLedgerRecord[] = [];

    for (const fileName of runFiles) {
      if (!fileName.endsWith(".json")) {
        continue;
      }

      const runLedger = await this.readRunLedgerRecord(path.join(this.runsDir, fileName));

      if (runLedger?.workItemId === workItemId) {
        relevantRuns.push(runLedger);
      }
    }

    return relevantRuns
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, RECENT_RUN_LIMIT);
  }
}

function applyPhaseMetadataUpdate(
  artifact: ArtifactRecord,
  phase: WorkPhase,
  options: { summary: string | null; updatedAt: string },
): ArtifactRecord {
  return {
    ...artifact,
    phase,
    state: "ready",
    summary: options.summary,
    updatedAt: options.updatedAt,
    designReady: phase === "design" ? true : artifact.designReady,
    planReady: phase === "plan" ? true : artifact.planReady,
    implementationNotesPresent:
      phase === "implement" ? true : artifact.implementationNotesPresent,
    reviewSummaryPresent: phase === "review" ? true : artifact.reviewSummaryPresent,
  };
}

function renderDefaultContextSection(workItem: WorkItemRecord): string {
  const lines = [
    `- Work Item ID: \`${workItem.id}\``,
    `- Title: ${workItem.title}`,
  ];

  if (workItem.identifier !== undefined && workItem.identifier !== null) {
    lines.splice(1, 0, `- Identifier: \`${workItem.identifier}\``);
  }

  if (workItem.url !== undefined && workItem.url !== null) {
    lines.push(`- URL: ${workItem.url}`);
  }

  if (workItem.description !== undefined && workItem.description !== null) {
    lines.push("", workItem.description.trim());
  }

  return lines.join("\n");
}

function buildArtifactTitle(workItem: WorkItemRecord): string {
  if (workItem.identifier !== undefined && workItem.identifier !== null) {
    return `${workItem.identifier} - ${workItem.title}`;
  }

  return workItem.title;
}

function createArtifactTemplateVariables(
  workItem: WorkItemRecord,
): TemplateVariables {
  return {
    createdAt: createTimestamp(),
    "workItem.id": workItem.id,
    "workItem.identifier": workItem.identifier ?? "",
    "workItem.title": workItem.title,
    "workItem.url": workItem.url ?? "",
    "workItem.description": workItem.description ?? "",
  };
}

function renderRunHistoryDigest(runs: RunLedgerRecord[]): string {
  return [
    "# Recent Run History",
    "",
    ...runs.map((run) => {
      const lines = [
        `- Run ID: \`${run.runId}\``,
        `  Phase: \`${run.phase}\``,
        `  Status: \`${run.status}\``,
        `  Updated At: \`${run.updatedAt}\``,
      ];

      if (run.summary !== undefined && run.summary !== null) {
        lines.push(`  Summary: ${run.summary}`);
      }

      if (run.error !== undefined && run.error !== null) {
        lines.push(`  Error: ${run.error.message}`);
      }

      return lines.join("\n");
    }),
  ].join("\n");
}

function upsertManagedSection(
  document: string,
  phase: WorkPhase,
  heading: string,
  content: string,
): string {
  return upsertSectionBody(document, heading, content, {
    startMarker: startMarker(phase),
    endMarker: endMarker(phase),
  });
}

function startMarker(phase: WorkPhase): string {
  return `<!-- orqestrate:phase:${phase}:start -->`;
}

function endMarker(phase: WorkPhase): string {
  return `<!-- orqestrate:phase:${phase}:end -->`;
}

function getSectionDefinition(phase: WorkPhase) {
  const definition = SECTION_DEFINITIONS.find((section) => section.phase === phase);

  if (definition === undefined) {
    throw new Error(`Unsupported phase '${phase}'.`);
  }

  return definition;
}

function firstConfiguredTemplatePath(
  templates: Record<string, string>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const templatePath = templates[key];

    if (templatePath !== undefined && templatePath.trim() !== "") {
      return templatePath;
    }
  }

  return undefined;
}

function renderTemplate(
  template: string,
  variables: TemplateVariables,
): string {
  return template.replace(/{{\s*([A-Za-z0-9_.-]+)\s*}}/g, (_, rawKey: string) => {
    return variables[rawKey] ?? "";
  });
}

function renderVerificationSection(input: {
  evidencePath: string;
  latestSection: string;
  latestTimestamp: string;
}): string {
  return [
    `- Verification evidence file: \`${input.evidencePath}\``,
    `- Latest evidence update: \`${input.latestTimestamp}\``,
    `- Latest evidence section: ${input.latestSection}`,
    "- Detailed verification output lives in the append-only evidence file.",
  ].join("\n");
}

function upsertSectionBody(
  document: string,
  heading: string,
  content: string,
  options: {
    startMarker: string;
    endMarker: string;
    nextHeading?: string;
  },
): string {
  const withSection = document.includes(options.startMarker)
    ? document
    : insertSectionMarkers(document, heading, options);
  const replacement = [
    options.startMarker,
    content.length > 0 ? content : "_No content provided._",
    options.endMarker,
  ].join("\n");
  const markerPattern = new RegExp(
    `${escapeRegExp(options.startMarker)}[\\s\\S]*?${escapeRegExp(options.endMarker)}`,
  );

  return withSection.replace(markerPattern, replacement);
}

function insertSectionMarkers(
  document: string,
  heading: string,
  options: {
    startMarker: string;
    endMarker: string;
    nextHeading?: string;
  },
): string {
  const sectionHeading = `# ${heading}`;
  const nextHeading = options.nextHeading ?? "";
  const fallbackBody = "_No content provided._";
  const escapedHeading = escapeRegExp(sectionHeading);
  const escapedNextHeading = nextHeading.length > 0 ? escapeRegExp(nextHeading) : "";
  const sectionPattern =
    nextHeading.length > 0
      ? new RegExp(`(${escapedHeading}\\n\\n)([\\s\\S]*?)(\\n(?=${escapedNextHeading}))`)
      : new RegExp(`(${escapedHeading}\\n\\n)([\\s\\S]*)`);

  if (sectionPattern.test(document)) {
    return document.replace(sectionPattern, (_match, prefix: string, body: string, suffix = "") => {
      const trimmedBody = body.trimEnd();
      const sectionBody = trimmedBody.length > 0 ? trimmedBody : fallbackBody;

      return `${prefix}${options.startMarker}\n${sectionBody}\n${options.endMarker}${suffix}`;
    });
  }

  return [
    document.trimEnd(),
    "",
    sectionHeading,
    "",
    options.startMarker,
    fallbackBody,
    options.endMarker,
  ].join("\n");
}

function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new Error(
      `Run id '${runId}' is not filesystem-safe. Use only letters, numbers, dots, underscores, and hyphens.`,
    );
  }
}

function toWorkItemKey(workItemId: string): string {
  return workItemId
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function createTimestamp(): string {
  return new Date().toISOString();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  const raw = await readFile(filePath, "utf8").catch(() => null);

  if (raw === null) {
    return null;
  }

  return JSON.parse(raw) as T;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
