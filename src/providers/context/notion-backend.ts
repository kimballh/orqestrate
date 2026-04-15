import type { ContextNotionProviderConfig } from "../../config/types.js";
import type {
  AppendEvidenceInput,
  ContextBundle,
  CreateRunLedgerEntryInput,
  EnsureArtifactInput,
  FinalizeRunLedgerEntryInput,
  LoadContextBundleInput,
  WritePhaseArtifactInput,
} from "../../core/context-backend.js";
import type { ProviderHealthCheckResult } from "../../core/provider-backend.js";
import type {
  ArtifactRecord,
  ArtifactState,
  ProviderError,
  RunLedgerRecord,
  RunStatus,
  WorkItemRecord,
  WorkPhase,
  WorkPhaseOrNone,
} from "../../domain-model.js";

import {
  NotionClient,
  type NotionClientLike,
  type NotionDataSource,
  type NotionPage,
  NotionRequestError,
  normalizeNotionId,
} from "./notion-client.js";
import { UnimplementedContextBackend } from "./unimplemented-context-backend.js";

type NotionTargetRole = "artifacts" | "runs";
type ArtifactSectionDefinition = {
  phase: WorkPhase;
  heading: string;
  placeholder: string;
};

type NotionArtifactSchema = {
  titlePropertyName: string;
  issueIdPropertyName: string;
  linearUrlPropertyName: string | null;
  currentPhasePropertyName: string;
  currentStatusPropertyName: string | null;
  artifactStatePropertyName: string;
  reviewOutcomePropertyName: string | null;
  lastUpdatedPropertyName: string;
  summaryPropertyName: string | null;
  designReadyPropertyName: string;
  planReadyPropertyName: string;
  implementationNotesPropertyName: string;
  reviewSummaryPropertyName: string;
  verificationEvidencePropertyName: string;
};

type NotionRunSchema = {
  titlePropertyName: string;
  runIdPropertyName: string;
  issueIdPropertyName: string;
  linearUrlPropertyName: string | null;
  phasePropertyName: string;
  statusPropertyName: string;
  startedAtPropertyName: string;
  endedAtPropertyName: string | null;
  artifactUrlPropertyName: string | null;
  summaryPropertyName: string | null;
  errorPropertyName: string | null;
};

const SECTION_DEFINITIONS: readonly ArtifactSectionDefinition[] = [
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
];
const VERIFICATION_SECTION_HEADING = "Verification";
const VERIFICATION_SECTION_START = "<!-- orqestrate:verification:start -->";
const VERIFICATION_SECTION_END = "<!-- orqestrate:verification:end -->";
const RECENT_RUN_LIMIT = 3;

export type ResolvedNotionContextConfig = {
  tokenEnv: string;
  token: string;
  artifactsDatabaseId: string;
  runsDatabaseId: string;
};

export type NotionContextTarget = {
  role: NotionTargetRole;
  databaseId: string;
  databaseTitle: string | null;
  databaseUrl: string | null;
  dataSourceId: string;
  dataSourceTitle: string | null;
  dataSourceUrl: string | null;
};

export type NotionContextTargets = {
  artifacts: NotionContextTarget;
  runs: NotionContextTarget;
};

export type NotionContextBackendOptions = {
  env?: NodeJS.ProcessEnv;
  client?: NotionClientLike;
  clientFactory?: (
    config: ResolvedNotionContextConfig,
  ) => NotionClientLike;
};

export class NotionContextBackend extends UnimplementedContextBackend<ContextNotionProviderConfig> {
  private readonly env: NodeJS.ProcessEnv;
  private readonly clientFactory: (
    config: ResolvedNotionContextConfig,
  ) => NotionClientLike;
  private client: NotionClientLike | null;
  private runtimeConfig: ResolvedNotionContextConfig | null;
  private targets: NotionContextTargets | null;
  private artifactDataSource: NotionDataSource | null;
  private artifactSchema: NotionArtifactSchema | null;
  private runDataSource: NotionDataSource | null;
  private runSchema: NotionRunSchema | null;

  constructor(
    config: ContextNotionProviderConfig,
    options: NotionContextBackendOptions = {},
  ) {
    super(config);
    this.env = options.env ?? process.env;
    this.client = options.client ?? null;
    this.runtimeConfig = null;
    this.targets = null;
    this.artifactDataSource = null;
    this.artifactSchema = null;
    this.runDataSource = null;
    this.runSchema = null;
    this.clientFactory =
      options.clientFactory ??
      ((resolvedConfig) => new NotionClient({ authToken: resolvedConfig.token }));
  }

  override async validateConfig(): Promise<void> {
    const runtimeConfig = this.resolveRuntimeConfig();

    if (runtimeConfig.artifactsDatabaseId === runtimeConfig.runsDatabaseId) {
      throw new Error(
        `Notion context provider '${this.name}' must use different databases for artifacts and runs.`,
      );
    }

    this.runtimeConfig = runtimeConfig;

    if (this.client === null) {
      this.client = this.clientFactory(runtimeConfig);
    }
  }

  override async healthCheck(): Promise<ProviderHealthCheckResult> {
    try {
      const { client, runtimeConfig } = this.ensureRuntime();
      const identity = await client.getTokenBotUser();
      const artifacts = await this.resolveTarget(
        "artifacts",
        runtimeConfig.artifactsDatabaseId,
      );
      const runs = await this.resolveTarget("runs", runtimeConfig.runsDatabaseId);

      this.targets = { artifacts, runs };
      this.artifactDataSource = await client.retrieveDataSource(artifacts.dataSourceId);
      this.artifactSchema = resolveArtifactSchema(this.artifactDataSource);
      this.runDataSource = await client.retrieveDataSource(runs.dataSourceId);
      this.runSchema = resolveRunSchema(this.runDataSource);

      return {
        ok: true,
        message: `Authenticated to Notion as '${identity.name ?? identity.id}', resolved both configured data sources, and validated the artifacts and runs schemas.`,
      };
    } catch (error) {
      if (error instanceof Error) {
        this.targets = null;
        this.artifactDataSource = null;
        this.artifactSchema = null;
        this.runDataSource = null;
        this.runSchema = null;
        return {
          ok: false,
          message: error.message,
        };
      }

      throw error;
    }
  }

  getClient(): NotionClientLike {
    return this.ensureRuntime().client;
  }

  getResolvedTargets(): NotionContextTargets | null {
    return this.targets;
  }

  getResolvedConfig(): ResolvedNotionContextConfig {
    return this.ensureRuntime().runtimeConfig;
  }

  override async ensureArtifact(input: EnsureArtifactInput): Promise<ArtifactRecord> {
    const existingArtifact = await this.getArtifactByWorkItemId(input.workItem.id);

    if (existingArtifact !== null) {
      await this.ensureArtifactScaffold(existingArtifact.artifactId, input.workItem);
      const refreshedArtifact = await this.getArtifactByWorkItemId(input.workItem.id);
      return refreshedArtifact ?? existingArtifact;
    }

    const client = this.getClient();
    const targets = await this.ensureTargets();
    const artifactDataSource = await this.getArtifactDataSource();
    const artifactSchema = await this.getArtifactSchema();
    const now = createTimestamp();
    const createdPage = await client.createPage({
      parent: {
        data_source_id: targets.artifacts.dataSourceId,
      },
      properties: buildArtifactProperties({
        dataSource: artifactDataSource,
        schema: artifactSchema,
        workItem: input.workItem,
        phase: "none",
        state: "draft",
        summary: null,
        updatedAt: now,
        designReady: false,
        planReady: false,
        implementationNotesPresent: false,
        reviewSummaryPresent: false,
        verificationEvidencePresent: false,
      }),
    });

    await this.ensureArtifactScaffold(createdPage.id, input.workItem);

    const hydratedArtifact = await this.getArtifactByWorkItemId(input.workItem.id);
    return hydratedArtifact ?? toArtifactRecord(createdPage, artifactSchema, input.workItem.id);
  }

  override async getArtifactByWorkItemId(
    workItemId: string,
  ): Promise<ArtifactRecord | null> {
    const artifactPage = await this.findArtifactPageByWorkItemId(workItemId);

    if (artifactPage === null) {
      return null;
    }

    return toArtifactRecord(artifactPage, await this.getArtifactSchema(), workItemId);
  }

  override async loadContextBundle(
    input: LoadContextBundleInput,
  ): Promise<ContextBundle> {
    const artifact =
      input.artifact ?? (await this.getArtifactByWorkItemId(input.workItem.id));

    if (artifact === null) {
      return {
        artifact: null,
        contextText: "",
        references: [],
      };
    }

    const markdown = await this.getClient().retrievePageMarkdown(artifact.artifactId);
    const recentRuns = await this.loadRecentRunsForWorkItem(input.workItem.id);
    const references = [
      {
        kind: "artifact",
        title: artifact.title,
        url: artifact.url ?? null,
      },
      ...recentRuns.map((run) => ({
        kind: "run_ledger",
        title: `Run ${run.runId} (${run.status})`,
        url: run.url ?? null,
      })),
    ];

    return {
      artifact,
      contextText: [
        markdown.markdown.trim(),
        recentRuns.length > 0 ? renderRunHistoryDigest(recentRuns) : "",
      ]
        .filter((part) => part.length > 0)
        .join("\n\n"),
      references,
    };
  }

  override async writePhaseArtifact(
    input: WritePhaseArtifactInput,
  ): Promise<ArtifactRecord> {
    const ensuredArtifact =
      input.artifact ?? (await this.ensureArtifact({ workItem: input.workItem }));
    const client = this.getClient();
    const artifactDataSource = await this.getArtifactDataSource();
    const artifactSchema = await this.getArtifactSchema();
    const section = getSectionDefinition(input.phase);
    const currentMarkdown = await client.retrievePageMarkdown(ensuredArtifact.artifactId);
    const baseMarkdown =
      currentMarkdown.markdown.trim() === ""
        ? renderArtifactDocument(input.workItem)
        : currentMarkdown.markdown;
    const nextMarkdown = upsertManagedSection(
      baseMarkdown,
      input.phase,
      section.heading,
      input.content.trim(),
    );

    await client.updatePageMarkdown(ensuredArtifact.artifactId, {
      type: "replace_content",
      newString: nextMarkdown,
    });

    const summary =
      input.summary === undefined ? ensuredArtifact.summary ?? null : input.summary;
    const updatedAt = createTimestamp();
    const updatedPage = await client.updatePage(ensuredArtifact.artifactId, {
      properties: buildArtifactProperties({
        dataSource: artifactDataSource,
        schema: artifactSchema,
        workItem: input.workItem,
        phase: input.phase,
        state: "ready",
        summary,
        updatedAt,
        designReady: input.phase === "design" ? true : ensuredArtifact.designReady,
        planReady: input.phase === "plan" ? true : ensuredArtifact.planReady,
        implementationNotesPresent:
          input.phase === "implement"
            ? true
            : ensuredArtifact.implementationNotesPresent,
        reviewSummaryPresent:
          input.phase === "review" ? true : ensuredArtifact.reviewSummaryPresent,
        verificationEvidencePresent: ensuredArtifact.verificationEvidencePresent,
      }),
    });
    const nextArtifact = toArtifactRecord(
      updatedPage,
      artifactSchema,
      input.workItem.id,
    );

    return artifactSchema.summaryPropertyName === null
      ? {
          ...nextArtifact,
          summary,
          updatedAt,
        }
      : nextArtifact;
  }

  override async createRunLedgerEntry(
    input: CreateRunLedgerEntryInput,
  ): Promise<RunLedgerRecord> {
    const existingRun = await this.findRunPageByRunId(input.runId);

    if (existingRun !== null) {
      throw new Error(`Run ledger '${input.runId}' already exists.`);
    }

    const client = this.getClient();
    const runDataSource = await this.getRunDataSource();
    const runSchema = await this.getRunSchema();
    const targets = await this.ensureTargets();
    const artifact = await this.getArtifactByWorkItemId(input.workItem.id);
    const now = createTimestamp();
    const createdPage = await client.createPage({
      parent: {
        data_source_id: targets.runs.dataSourceId,
      },
      properties: buildRunProperties({
        dataSource: runDataSource,
        schema: runSchema,
        runId: input.runId,
        workItem: input.workItem,
        phase: input.phase,
        status: input.status,
        startedAt: now,
        endedAt: null,
        artifact,
        summary: null,
        error: null,
      }),
    });

    await this.ensureRunScaffold(createdPage.id, {
      runId: input.runId,
      workItemId: input.workItem.id,
      phase: input.phase,
      status: input.status,
      startedAt: now,
      artifactUrl: artifact?.url ?? null,
    });

    const nextRun = toRunLedgerRecord(
      createdPage,
      runDataSource,
      runSchema,
      input.runId,
      input.workItem.id,
    );

    return runSchema.artifactUrlPropertyName === null
      ? {
          ...nextRun,
          artifactId: artifact?.artifactId ?? null,
          startedAt: now,
          updatedAt: now,
        }
      : nextRun;
  }

  override async finalizeRunLedgerEntry(
    input: FinalizeRunLedgerEntryInput,
  ): Promise<RunLedgerRecord> {
    const currentPage = await this.findRunPageByRunId(input.runId);

    if (currentPage === null) {
      throw new Error(`Run ledger '${input.runId}' does not exist.`);
    }

    const client = this.getClient();
    const runDataSource = await this.getRunDataSource();
    const runSchema = await this.getRunSchema();
    const now = createTimestamp();
    const updatedPage = await client.updatePage(currentPage.id, {
      properties: buildRunUpdateProperties({
        dataSource: runDataSource,
        schema: runSchema,
        status: input.status,
        endedAt: now,
        summary: input.summary === undefined ? undefined : input.summary,
        error: input.error === undefined ? undefined : input.error,
      }),
    });
    const workItemId =
      readStringPropertyValue(currentPage.properties[runSchema.issueIdPropertyName]) ??
      "unknown";
    const nextRun = toRunLedgerRecord(
      updatedPage,
      runDataSource,
      runSchema,
      input.runId,
      workItemId,
    );

    return {
      ...nextRun,
      summary: input.summary === undefined ? nextRun.summary ?? null : input.summary,
      verification:
        input.verification === undefined
          ? nextRun.verification ?? null
          : input.verification,
      error: input.error === undefined ? nextRun.error ?? null : input.error,
      endedAt: now,
      updatedAt: updatedPage.lastEditedTime ?? now,
    };
  }

  override async appendEvidence(input: AppendEvidenceInput): Promise<void> {
    const runPage = await this.findRunPageByRunId(input.runId);

    if (runPage === null) {
      throw new Error(`Run ledger '${input.runId}' does not exist.`);
    }

    const client = this.getClient();
    const runSchema = await this.getRunSchema();
    const currentMarkdown = await client.retrievePageMarkdown(runPage.id);
    const startedAt =
      readDatePropertyValue(runPage.properties[runSchema.startedAtPropertyName]) ??
      runPage.createdTime ??
      createTimestamp();
    const artifactUrl =
      runSchema.artifactUrlPropertyName === null
        ? null
        : readStringPropertyValue(runPage.properties[runSchema.artifactUrlPropertyName]);
    const baseMarkdown =
      currentMarkdown.markdown.trim() === ""
        ? renderRunDocument({
            runId: input.runId,
            workItemId: input.workItemId,
            phase: parseWorkPhaseOrNone(
              readStringPropertyValue(runPage.properties[runSchema.phasePropertyName]),
            ) === "none"
              ? "implement"
              : (parseWorkPhaseOrNone(
                  readStringPropertyValue(runPage.properties[runSchema.phasePropertyName]),
                ) as WorkPhase),
            status: parseRunStatus(
              readStringPropertyValue(runPage.properties[runSchema.statusPropertyName]),
            ),
            startedAt,
            artifactUrl,
          })
        : currentMarkdown.markdown;
    const timestamp = createTimestamp();
    const evidenceBlock = [
      `## ${timestamp} - ${input.section}`,
      "",
      input.content.trim(),
      "",
    ].join("\n");

    await client.updatePageMarkdown(runPage.id, {
      type: "replace_content",
      newString: `${baseMarkdown.trimEnd()}\n\n${evidenceBlock}`,
    });

    const artifact = await this.getArtifactByWorkItemId(input.workItemId);

    if (artifact === null) {
      return;
    }

    const artifactDataSource = await this.getArtifactDataSource();
    const artifactSchema = await this.getArtifactSchema();
    const artifactMarkdown = await client.retrievePageMarkdown(artifact.artifactId);
    const verificationSummary = renderVerificationSection({
      runId: input.runId,
      runUrl: runPage.url,
      latestSection: input.section,
      latestTimestamp: timestamp,
    });
    const nextArtifactMarkdown = upsertSectionBody(
      artifactMarkdown.markdown.trim() === ""
        ? renderArtifactDocument({
            ...createMinimalWorkItem(input.workItemId, {
              identifier: null,
              title: artifact.title,
              url: artifact.url ?? null,
            }),
          })
        : artifactMarkdown.markdown,
      VERIFICATION_SECTION_HEADING,
      verificationSummary,
      {
        startMarker: VERIFICATION_SECTION_START,
        endMarker: VERIFICATION_SECTION_END,
        nextHeading: "# Decision Log",
      },
    );

    await client.updatePageMarkdown(artifact.artifactId, {
      type: "replace_content",
      newString: nextArtifactMarkdown,
    });

    await client.updatePage(artifact.artifactId, {
      properties: {
        [artifactSchema.verificationEvidencePropertyName]: serializePropertyValue(
          artifactDataSource,
          artifactSchema.verificationEvidencePropertyName,
          true,
        ),
        [artifactSchema.lastUpdatedPropertyName]: serializePropertyValue(
          artifactDataSource,
          artifactSchema.lastUpdatedPropertyName,
          timestamp,
        ),
      },
    });
  }

  private ensureRuntime(): {
    client: NotionClientLike;
    runtimeConfig: ResolvedNotionContextConfig;
  } {
    const runtimeConfig = this.runtimeConfig ?? this.resolveRuntimeConfig();
    const client = this.client ?? this.clientFactory(runtimeConfig);

    this.runtimeConfig = runtimeConfig;
    this.client = client;

    return { client, runtimeConfig };
  }

  private async ensureTargets(): Promise<NotionContextTargets> {
    if (this.targets !== null) {
      return this.targets;
    }

    const { runtimeConfig } = this.ensureRuntime();
    const targets: NotionContextTargets = {
      artifacts: await this.resolveTarget(
        "artifacts",
        runtimeConfig.artifactsDatabaseId,
      ),
      runs: await this.resolveTarget("runs", runtimeConfig.runsDatabaseId),
    };

    this.targets = targets;

    return targets;
  }

  private resolveRuntimeConfig(): ResolvedNotionContextConfig {
    const artifactsDatabaseId = normalizeConfiguredDatabaseId(
      this.config.artifactsDatabaseId,
      `providers.${this.name}.artifacts_database_id`,
    );
    const runsDatabaseId = normalizeConfiguredDatabaseId(
      this.config.runsDatabaseId,
      `providers.${this.name}.runs_database_id`,
    );
    const token = resolveRuntimeToken(this.config, this.env);

    return {
      tokenEnv: this.config.tokenEnv,
      token,
      artifactsDatabaseId,
      runsDatabaseId,
    };
  }

  private async resolveTarget(
    role: NotionTargetRole,
    databaseId: string,
  ): Promise<NotionContextTarget> {
    const { client } = this.ensureRuntime();

    try {
      const database = await client.retrieveDatabase(databaseId);

      if (database.dataSources.length !== 1) {
        const count = database.dataSources.length;
        const title = database.title ?? database.id;

        throw new Error(
          `Notion ${role} database '${title}' must expose exactly one data source, but ${count} were found.`,
        );
      }

      const dataSource = await client.retrieveDataSource(database.dataSources[0].id);

      if (
        dataSource.parentDatabaseId !== null &&
        dataSource.parentDatabaseId !== database.id
      ) {
        throw new Error(
          `Notion ${role} data source '${dataSource.id}' does not belong to database '${database.id}'.`,
        );
      }

      return {
        role,
        databaseId: database.id,
        databaseTitle: database.title,
        databaseUrl: database.url,
        dataSourceId: dataSource.id,
        dataSourceTitle: dataSource.title ?? database.dataSources[0].name,
        dataSourceUrl: dataSource.url,
      };
    } catch (error) {
      throw describeTargetResolutionError(role, databaseId, error);
    }
  }

  private async getArtifactDataSource(): Promise<NotionDataSource> {
    if (this.artifactDataSource !== null) {
      return this.artifactDataSource;
    }

    const targets = await this.ensureTargets();
    const dataSource = await this.getClient().retrieveDataSource(
      targets.artifacts.dataSourceId,
    );

    this.artifactDataSource = dataSource;

    return dataSource;
  }

  private async getArtifactSchema(): Promise<NotionArtifactSchema> {
    if (this.artifactSchema !== null) {
      return this.artifactSchema;
    }

    this.artifactSchema = resolveArtifactSchema(await this.getArtifactDataSource());

    return this.artifactSchema;
  }

  private async getRunDataSource(): Promise<NotionDataSource> {
    if (this.runDataSource !== null) {
      return this.runDataSource;
    }

    const targets = await this.ensureTargets();
    const dataSource = await this.getClient().retrieveDataSource(
      targets.runs.dataSourceId,
    );

    this.runDataSource = dataSource;

    return dataSource;
  }

  private async getRunSchema(): Promise<NotionRunSchema> {
    if (this.runSchema !== null) {
      return this.runSchema;
    }

    this.runSchema = resolveRunSchema(await this.getRunDataSource());

    return this.runSchema;
  }

  private async findArtifactPageByWorkItemId(
    workItemId: string,
  ): Promise<NotionPage | null> {
    const schema = await this.getArtifactSchema();
    const artifactDataSource = await this.getArtifactDataSource();
    const targets = await this.ensureTargets();
    const issueIdPropertyType =
      artifactDataSource.properties[schema.issueIdPropertyName]?.type ?? "unknown";
    const results = await this.getClient().queryDataSourcePages({
      dataSourceId: targets.artifacts.dataSourceId,
      filter: buildExactMatchFilter(
        schema.issueIdPropertyName,
        issueIdPropertyType,
        workItemId,
      ),
      pageSize: 2,
    });

    if (results.results.length > 1) {
      throw new Error(
        `Notion artifacts data source returned multiple pages for work item '${workItemId}'. Expected a single durable artifact page.`,
      );
    }

    return results.results[0] ?? null;
  }

  private async findRunPageByRunId(runId: string): Promise<NotionPage | null> {
    const schema = await this.getRunSchema();
    const runDataSource = await this.getRunDataSource();
    const targets = await this.ensureTargets();
    const runIdPropertyType =
      runDataSource.properties[schema.runIdPropertyName]?.type ?? "unknown";
    const results = await this.getClient().queryDataSourcePages({
      dataSourceId: targets.runs.dataSourceId,
      filter: buildExactMatchFilter(
        schema.runIdPropertyName,
        runIdPropertyType,
        runId,
      ),
      pageSize: 2,
    });

    if (results.results.length > 1) {
      throw new Error(
        `Notion runs data source returned multiple pages for run '${runId}'. Expected a single durable run ledger row.`,
      );
    }

    return results.results[0] ?? null;
  }

  private async loadRecentRunsForWorkItem(
    workItemId: string,
  ): Promise<RunLedgerRecord[]> {
    const schema = await this.getRunSchema();
    const runDataSource = await this.getRunDataSource();
    const targets = await this.ensureTargets();
    const issueIdPropertyType =
      runDataSource.properties[schema.issueIdPropertyName]?.type ?? "unknown";
    const pages: NotionPage[] = [];
    let nextCursor: string | undefined;

    do {
      const results = await this.getClient().queryDataSourcePages({
        dataSourceId: targets.runs.dataSourceId,
        filter: buildExactMatchFilter(
          schema.issueIdPropertyName,
          issueIdPropertyType,
          workItemId,
        ),
        sorts: [
          {
            property: schema.startedAtPropertyName,
            direction: "descending",
          },
        ],
        startCursor: nextCursor,
        pageSize: RECENT_RUN_LIMIT,
      });

      pages.push(...results.results);
      nextCursor = results.hasMore ? results.nextCursor ?? undefined : undefined;
    } while (pages.length < RECENT_RUN_LIMIT && nextCursor !== undefined);

    return pages
      .map((page) => toRunLedgerRecord(page, runDataSource, schema, page.id, workItemId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, RECENT_RUN_LIMIT);
  }

  private async ensureArtifactScaffold(
    artifactId: string,
    workItem: WorkItemRecord,
  ): Promise<void> {
    const client = this.getClient();
    const markdown = await client.retrievePageMarkdown(artifactId);

    if (hasArtifactScaffold(markdown.markdown)) {
      return;
    }

    await client.updatePageMarkdown(artifactId, {
      type: "replace_content",
      newString: renderArtifactDocument(workItem),
    });
  }

  private async ensureRunScaffold(
    runPageId: string,
    input: {
      runId: string;
      workItemId: string;
      phase: WorkPhase;
      status: RunStatus;
      startedAt: string;
      artifactUrl: string | null;
    },
  ): Promise<void> {
    const client = this.getClient();
    const markdown = await client.retrievePageMarkdown(runPageId);

    if (hasRunScaffold(markdown.markdown)) {
      return;
    }

    await client.updatePageMarkdown(runPageId, {
      type: "replace_content",
      newString: renderRunDocument(input),
    });
  }
}

function resolveRuntimeToken(
  config: ContextNotionProviderConfig,
  env: NodeJS.ProcessEnv,
): string {
  const token = env[config.tokenEnv];

  if (token === undefined || token.trim() === "") {
    throw new Error(
      `Env var '${config.tokenEnv}' is not set for Notion context provider '${config.name}'.`,
    );
  }

  return token.trim();
}

function normalizeConfiguredDatabaseId(value: string, fieldPath: string): string {
  if (value.trim().toLowerCase() === "replace-me") {
    throw new Error(
      `Configured value at '${fieldPath}' must be replaced with a real Notion database ID before this profile can start.`,
    );
  }

  try {
    return normalizeNotionId(value);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`${fieldPath} ${error.message}`);
    }

    throw error;
  }
}

function resolveArtifactSchema(dataSource: NotionDataSource): NotionArtifactSchema {
  const titlePropertyName =
    Object.entries(dataSource.properties).find(
      ([, property]) => property.type === "title",
    )?.[0] ?? null;

  if (titlePropertyName === null) {
    throw new Error(
      `Notion artifacts data source '${dataSource.id}' must expose a title property.`,
    );
  }

  assertPropertyType(dataSource, "Linear Issue ID", ["rich_text"]);
  assertPropertyType(dataSource, "Current Phase", ["rich_text", "select"]);
  assertPropertyType(dataSource, "Artifact State", ["rich_text", "select"]);
  assertPropertyType(dataSource, "Last Updated At", ["date"]);
  assertPropertyType(dataSource, "Design Ready", ["checkbox"]);
  assertPropertyType(dataSource, "Plan Ready", ["checkbox"]);
  assertPropertyType(dataSource, "Implementation Notes Present", ["checkbox"]);
  assertPropertyType(dataSource, "Review Summary Present", ["checkbox"]);
  assertPropertyType(dataSource, "Verification Evidence Present", ["checkbox"]);

  if ("Linear URL" in dataSource.properties) {
    assertPropertyType(dataSource, "Linear URL", ["url"]);
  }

  if ("Current Status Snapshot" in dataSource.properties) {
    assertPropertyType(dataSource, "Current Status Snapshot", [
      "rich_text",
      "select",
      "status",
    ]);
  }

  if ("Review Outcome" in dataSource.properties) {
    assertPropertyType(dataSource, "Review Outcome", ["rich_text", "select"]);
  }

  if ("Summary" in dataSource.properties) {
    assertPropertyType(dataSource, "Summary", ["rich_text"]);
  }

  return {
    titlePropertyName,
    issueIdPropertyName: "Linear Issue ID",
    linearUrlPropertyName:
      "Linear URL" in dataSource.properties ? "Linear URL" : null,
    currentPhasePropertyName: "Current Phase",
    currentStatusPropertyName:
      "Current Status Snapshot" in dataSource.properties
        ? "Current Status Snapshot"
        : null,
    artifactStatePropertyName: "Artifact State",
    reviewOutcomePropertyName:
      "Review Outcome" in dataSource.properties ? "Review Outcome" : null,
    lastUpdatedPropertyName: "Last Updated At",
    summaryPropertyName: "Summary" in dataSource.properties ? "Summary" : null,
    designReadyPropertyName: "Design Ready",
    planReadyPropertyName: "Plan Ready",
    implementationNotesPropertyName: "Implementation Notes Present",
    reviewSummaryPropertyName: "Review Summary Present",
    verificationEvidencePropertyName: "Verification Evidence Present",
  };
}

function resolveRunSchema(dataSource: NotionDataSource): NotionRunSchema {
  const titlePropertyName =
    Object.entries(dataSource.properties).find(
      ([, property]) => property.type === "title",
    )?.[0] ?? null;

  if (titlePropertyName === null) {
    throw new Error(
      `Notion runs data source '${dataSource.id}' must expose a title property.`,
    );
  }

  assertPropertyType(dataSource, "Run ID", ["rich_text"]);
  assertPropertyType(dataSource, "Linear Issue ID", ["rich_text"]);
  assertPropertyType(dataSource, "Phase", ["rich_text", "select"]);
  assertPropertyType(dataSource, "Status", ["rich_text", "select", "status"]);
  assertPropertyType(dataSource, "Started At", ["date"]);

  if ("Linear URL" in dataSource.properties) {
    assertPropertyType(dataSource, "Linear URL", ["url"]);
  }

  if ("Ended At" in dataSource.properties) {
    assertPropertyType(dataSource, "Ended At", ["date"]);
  }

  if ("Artifact Page" in dataSource.properties) {
    assertPropertyType(dataSource, "Artifact Page", ["url", "rich_text"]);
  }

  if ("Summary" in dataSource.properties) {
    assertPropertyType(dataSource, "Summary", ["rich_text"]);
  }

  if ("Error" in dataSource.properties) {
    assertPropertyType(dataSource, "Error", ["rich_text"]);
  }

  return {
    titlePropertyName,
    runIdPropertyName: "Run ID",
    issueIdPropertyName: "Linear Issue ID",
    linearUrlPropertyName:
      "Linear URL" in dataSource.properties ? "Linear URL" : null,
    phasePropertyName: "Phase",
    statusPropertyName: "Status",
    startedAtPropertyName: "Started At",
    endedAtPropertyName: "Ended At" in dataSource.properties ? "Ended At" : null,
    artifactUrlPropertyName:
      "Artifact Page" in dataSource.properties ? "Artifact Page" : null,
    summaryPropertyName: "Summary" in dataSource.properties ? "Summary" : null,
    errorPropertyName: "Error" in dataSource.properties ? "Error" : null,
  };
}

function buildArtifactProperties(input: {
  dataSource: NotionDataSource;
  schema: NotionArtifactSchema;
  workItem: WorkItemRecord;
  phase: WorkPhaseOrNone;
  state: ArtifactState;
  summary: string | null;
  updatedAt: string;
  designReady: boolean;
  planReady: boolean;
  implementationNotesPresent: boolean;
  reviewSummaryPresent: boolean;
  verificationEvidencePresent: boolean;
}): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    [input.schema.titlePropertyName]: serializePropertyValue(
      input.dataSource,
      input.schema.titlePropertyName,
      buildArtifactTitle(input.workItem),
    ),
    [input.schema.issueIdPropertyName]: serializePropertyValue(
      input.dataSource,
      input.schema.issueIdPropertyName,
      input.workItem.id,
    ),
    [input.schema.currentPhasePropertyName]: serializePropertyValue(
      input.dataSource,
      input.schema.currentPhasePropertyName,
      input.phase,
    ),
    [input.schema.artifactStatePropertyName]: serializePropertyValue(
      input.dataSource,
      input.schema.artifactStatePropertyName,
      input.state,
    ),
    [input.schema.lastUpdatedPropertyName]: serializePropertyValue(
      input.dataSource,
      input.schema.lastUpdatedPropertyName,
      input.updatedAt,
    ),
    [input.schema.designReadyPropertyName]: serializePropertyValue(
      input.dataSource,
      input.schema.designReadyPropertyName,
      input.designReady,
    ),
    [input.schema.planReadyPropertyName]: serializePropertyValue(
      input.dataSource,
      input.schema.planReadyPropertyName,
      input.planReady,
    ),
    [input.schema.implementationNotesPropertyName]: serializePropertyValue(
      input.dataSource,
      input.schema.implementationNotesPropertyName,
      input.implementationNotesPresent,
    ),
    [input.schema.reviewSummaryPropertyName]: serializePropertyValue(
      input.dataSource,
      input.schema.reviewSummaryPropertyName,
      input.reviewSummaryPresent,
    ),
    [input.schema.verificationEvidencePropertyName]: serializePropertyValue(
      input.dataSource,
      input.schema.verificationEvidencePropertyName,
      input.verificationEvidencePresent,
    ),
  };

  if (input.schema.linearUrlPropertyName !== null) {
    properties[input.schema.linearUrlPropertyName] = serializePropertyValue(
      input.dataSource,
      input.schema.linearUrlPropertyName,
      input.workItem.url ?? null,
    );
  }

  if (input.schema.currentStatusPropertyName !== null) {
    properties[input.schema.currentStatusPropertyName] = serializePropertyValue(
      input.dataSource,
      input.schema.currentStatusPropertyName,
      input.workItem.status,
    );
  }

  if (input.schema.reviewOutcomePropertyName !== null) {
    properties[input.schema.reviewOutcomePropertyName] = serializePropertyValue(
      input.dataSource,
      input.schema.reviewOutcomePropertyName,
      input.workItem.orchestration.reviewOutcome ?? "none",
    );
  }

  if (input.schema.summaryPropertyName !== null) {
    properties[input.schema.summaryPropertyName] = serializePropertyValue(
      input.dataSource,
      input.schema.summaryPropertyName,
      input.summary,
    );
  }

  return properties;
}

function buildRunProperties(input: {
  dataSource: NotionDataSource;
  schema: NotionRunSchema;
  runId: string;
  workItem: WorkItemRecord;
  phase: WorkPhase;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  artifact: ArtifactRecord | null;
  summary: string | null;
  error: ProviderError | null;
}): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    [input.schema.titlePropertyName]: serializePropertyValue(
      input.dataSource,
      input.schema.titlePropertyName,
      buildRunTitle(input.runId, input.workItem),
    ),
    [input.schema.runIdPropertyName]: serializePropertyValue(
      input.dataSource,
      input.schema.runIdPropertyName,
      input.runId,
    ),
    [input.schema.issueIdPropertyName]: serializePropertyValue(
      input.dataSource,
      input.schema.issueIdPropertyName,
      input.workItem.id,
    ),
    [input.schema.phasePropertyName]: serializePropertyValue(
      input.dataSource,
      input.schema.phasePropertyName,
      input.phase,
    ),
    [input.schema.statusPropertyName]: serializePropertyValue(
      input.dataSource,
      input.schema.statusPropertyName,
      input.status,
    ),
    [input.schema.startedAtPropertyName]: serializePropertyValue(
      input.dataSource,
      input.schema.startedAtPropertyName,
      input.startedAt,
    ),
  };

  if (input.schema.linearUrlPropertyName !== null) {
    properties[input.schema.linearUrlPropertyName] = serializePropertyValue(
      input.dataSource,
      input.schema.linearUrlPropertyName,
      input.workItem.url ?? null,
    );
  }

  if (input.schema.endedAtPropertyName !== null) {
    properties[input.schema.endedAtPropertyName] = serializePropertyValue(
      input.dataSource,
      input.schema.endedAtPropertyName,
      input.endedAt,
    );
  }

  if (input.schema.artifactUrlPropertyName !== null) {
    properties[input.schema.artifactUrlPropertyName] = serializePropertyValue(
      input.dataSource,
      input.schema.artifactUrlPropertyName,
      serializeArtifactReference(
        input.dataSource,
        input.schema.artifactUrlPropertyName,
        input.artifact,
      ),
    );
  }

  if (input.schema.summaryPropertyName !== null) {
    properties[input.schema.summaryPropertyName] = serializePropertyValue(
      input.dataSource,
      input.schema.summaryPropertyName,
      input.summary,
    );
  }

  if (input.schema.errorPropertyName !== null) {
    properties[input.schema.errorPropertyName] = serializePropertyValue(
      input.dataSource,
      input.schema.errorPropertyName,
      serializeProviderError(input.error),
    );
  }

  return properties;
}

function buildRunUpdateProperties(input: {
  dataSource: NotionDataSource;
  schema: NotionRunSchema;
  status: RunStatus;
  endedAt: string;
  summary?: string | null;
  error?: ProviderError | null;
}): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    [input.schema.statusPropertyName]: serializePropertyValue(
      input.dataSource,
      input.schema.statusPropertyName,
      input.status,
    ),
  };

  if (input.schema.endedAtPropertyName !== null) {
    properties[input.schema.endedAtPropertyName] = serializePropertyValue(
      input.dataSource,
      input.schema.endedAtPropertyName,
      input.endedAt,
    );
  }

  if (input.summary !== undefined && input.schema.summaryPropertyName !== null) {
    properties[input.schema.summaryPropertyName] = serializePropertyValue(
      input.dataSource,
      input.schema.summaryPropertyName,
      input.summary,
    );
  }

  if (input.error !== undefined && input.schema.errorPropertyName !== null) {
    properties[input.schema.errorPropertyName] = serializePropertyValue(
      input.dataSource,
      input.schema.errorPropertyName,
      serializeProviderError(input.error),
    );
  }

  return properties;
}

function toArtifactRecord(
  page: NotionPage,
  schema: NotionArtifactSchema,
  fallbackWorkItemId: string,
): ArtifactRecord {
  const updatedAt =
    readDatePropertyValue(page.properties[schema.lastUpdatedPropertyName]) ??
    page.lastEditedTime ??
    page.createdTime ??
    createTimestamp();

  return {
    artifactId: page.id,
    workItemId:
      readStringPropertyValue(page.properties[schema.issueIdPropertyName]) ??
      fallbackWorkItemId,
    title:
      readStringPropertyValue(page.properties[schema.titlePropertyName]) ?? page.id,
    phase: parseWorkPhaseOrNone(
      readStringPropertyValue(page.properties[schema.currentPhasePropertyName]),
    ),
    state: parseArtifactState(
      readStringPropertyValue(page.properties[schema.artifactStatePropertyName]),
    ),
    url: page.url ?? null,
    summary:
      schema.summaryPropertyName === null
        ? null
        : readStringPropertyValue(page.properties[schema.summaryPropertyName]),
    designReady: readCheckboxPropertyValue(
      page.properties[schema.designReadyPropertyName],
    ),
    planReady: readCheckboxPropertyValue(page.properties[schema.planReadyPropertyName]),
    implementationNotesPresent: readCheckboxPropertyValue(
      page.properties[schema.implementationNotesPropertyName],
    ),
    reviewSummaryPresent: readCheckboxPropertyValue(
      page.properties[schema.reviewSummaryPropertyName],
    ),
    verificationEvidencePresent: readCheckboxPropertyValue(
      page.properties[schema.verificationEvidencePropertyName],
    ),
    updatedAt,
    createdAt: page.createdTime ?? updatedAt,
  };
}

function toRunLedgerRecord(
  page: NotionPage,
  dataSource: NotionDataSource,
  schema: NotionRunSchema,
  fallbackRunId: string,
  fallbackWorkItemId: string,
): RunLedgerRecord {
  const updatedAt =
    page.lastEditedTime ??
    readDatePropertyValue(page.properties[schema.endedAtPropertyName ?? ""]) ??
    readDatePropertyValue(page.properties[schema.startedAtPropertyName]) ??
    page.createdTime ??
    createTimestamp();

  return {
    runId:
      readStringPropertyValue(page.properties[schema.runIdPropertyName]) ??
      fallbackRunId,
    workItemId:
      readStringPropertyValue(page.properties[schema.issueIdPropertyName]) ??
      fallbackWorkItemId,
    artifactId:
      schema.artifactUrlPropertyName === null
        ? null
        : readArtifactReferenceId(
            page.properties[schema.artifactUrlPropertyName],
            dataSource.properties[schema.artifactUrlPropertyName]?.type ?? null,
          ),
    phase: parseRunPhase(
      readStringPropertyValue(page.properties[schema.phasePropertyName]),
    ),
    status: parseRunStatus(
      readStringPropertyValue(page.properties[schema.statusPropertyName]),
    ),
    summary:
      schema.summaryPropertyName === null
        ? null
        : readStringPropertyValue(page.properties[schema.summaryPropertyName]),
    verification: null,
    error:
      schema.errorPropertyName === null
        ? null
        : parseProviderError(
            readStringPropertyValue(page.properties[schema.errorPropertyName]),
          ),
    startedAt: readDatePropertyValue(page.properties[schema.startedAtPropertyName]),
    endedAt:
      schema.endedAtPropertyName === null
        ? null
        : readDatePropertyValue(page.properties[schema.endedAtPropertyName]),
    url: page.url ?? null,
    updatedAt,
  };
}

function buildExactMatchFilter(
  propertyName: string,
  propertyType: string,
  value: string,
): Record<string, unknown> {
  if (propertyType === "rich_text") {
    return {
      property: propertyName,
      rich_text: {
        equals: value,
      },
    };
  }

  throw new Error(
    `Notion property '${propertyName}' must use a supported exact-match type. Received '${propertyType}'.`,
  );
}

function serializePropertyValue(
  dataSource: NotionDataSource,
  propertyName: string,
  value: boolean | string | null,
): Record<string, unknown> {
  const propertyType = dataSource.properties[propertyName]?.type;

  switch (propertyType) {
    case "title":
      return {
        title: value === null ? [] : [toPlainTextObject(String(value))],
      };
    case "rich_text":
      return {
        rich_text: value === null ? [] : [toPlainTextObject(String(value))],
      };
    case "url":
      return {
        url: value === null ? null : String(value),
      };
    case "select":
      return {
        select: value === null ? null : { name: String(value) },
      };
    case "status":
      return {
        status: value === null ? null : { name: String(value) },
      };
    case "checkbox":
      return {
        checkbox: Boolean(value),
      };
    case "date":
      return {
        date:
          value === null
            ? null
            : {
                start: String(value),
              },
      };
    default:
      throw new Error(
        `Notion property '${propertyName}' uses unsupported type '${propertyType ?? "unknown"}'.`,
      );
  }
}

function toPlainTextObject(content: string): Record<string, unknown> {
  return {
    type: "text",
    text: {
      content,
    },
  };
}

function readStringPropertyValue(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const property = value as Record<string, unknown>;
  const propertyType = typeof property.type === "string" ? property.type : null;

  switch (propertyType) {
    case "title":
    case "rich_text":
      return richTextArrayToPlainText(property[propertyType]);
    case "url":
      return typeof property.url === "string" ? property.url : null;
    case "select":
      return extractNamedOption(property.select);
    case "status":
      return extractNamedOption(property.status);
    default:
      return null;
  }
}

function readCheckboxPropertyValue(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const checkbox = (value as Record<string, unknown>).checkbox;
  return checkbox === true;
}

function readDatePropertyValue(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const date = (value as Record<string, unknown>).date;

  if (typeof date !== "object" || date === null) {
    return null;
  }

  const start = (date as Record<string, unknown>).start;

  return typeof start === "string" ? start : null;
}

function extractNamedOption(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const name = (value as Record<string, unknown>).name;
  return typeof name === "string" ? name : null;
}

function richTextArrayToPlainText(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const plainText = value
    .map((part) => {
      if (typeof part !== "object" || part === null) {
        return "";
      }

      const richText = part as Record<string, unknown>;
      const plain = richText.plain_text;

      if (typeof plain === "string") {
        return plain;
      }

      const text = richText.text;

      if (typeof text !== "object" || text === null) {
        return "";
      }

      const content = (text as Record<string, unknown>).content;
      return typeof content === "string" ? content : "";
    })
    .join("")
    .trim();

  return plainText === "" ? null : plainText;
}

function assertPropertyType(
  dataSource: NotionDataSource,
  propertyName: string,
  supportedTypes: readonly string[],
): void {
  const property = dataSource.properties[propertyName];

  if (property === undefined) {
    throw new Error(
      `Notion artifacts data source '${dataSource.id}' must include a '${propertyName}' property.`,
    );
  }

  if (!supportedTypes.includes(property.type)) {
    throw new Error(
      `Notion artifacts property '${propertyName}' must use one of: ${supportedTypes.join(", ")}. Received '${property.type}'.`,
    );
  }
}

function parseWorkPhaseOrNone(value: string | null): WorkPhaseOrNone {
  switch (value) {
    case "design":
    case "plan":
    case "implement":
    case "review":
    case "merge":
    case "none":
      return value;
    default:
      return "none";
  }
}

function parseArtifactState(value: string | null): ArtifactState {
  switch (value) {
    case "missing":
    case "draft":
    case "ready":
    case "archived":
      return value;
    default:
      return "draft";
  }
}

function parseRunPhase(value: string | null): WorkPhase {
  switch (value) {
    case "design":
    case "plan":
    case "implement":
    case "review":
    case "merge":
      return value;
    default:
      return "implement";
  }
}

function parseRunStatus(value: string | null): RunStatus {
  switch (value) {
    case "queued":
    case "admitted":
    case "launching":
    case "bootstrapping":
    case "running":
    case "waiting_human":
    case "stopping":
    case "completed":
    case "failed":
    case "canceled":
    case "stale":
      return value;
    default:
      return "queued";
  }
}

function buildArtifactTitle(workItem: WorkItemRecord): string {
  if (workItem.identifier !== undefined && workItem.identifier !== null) {
    return `${workItem.identifier} - ${workItem.title}`;
  }

  return workItem.title;
}

function buildRunTitle(runId: string, workItem: WorkItemRecord): string {
  const workItemLabel =
    workItem.identifier ?? workItem.id;

  return `${runId} - ${workItemLabel}`;
}

function serializeArtifactReference(
  dataSource: NotionDataSource,
  propertyName: string,
  artifact: ArtifactRecord | null,
): string | null {
  if (artifact === null) {
    return null;
  }

  const propertyType = dataSource.properties[propertyName]?.type ?? null;

  if (propertyType === "rich_text") {
    return artifact.artifactId;
  }

  return artifact.url ?? null;
}

function readArtifactReferenceId(
  value: unknown,
  propertyType: string | null,
): string | null {
  if (propertyType === "rich_text" || propertyType === "url") {
    return readStringPropertyValue(value);
  }

  return null;
}

function renderArtifactDocument(workItem: WorkItemRecord): string {
  const createdAt = createTimestamp();

  return [
    "# Context",
    "",
    ...renderDefaultContextSection(workItem),
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

function renderRunDocument(input: {
  runId: string;
  workItemId: string;
  phase: WorkPhase;
  status: RunStatus;
  startedAt: string;
  artifactUrl: string | null;
}): string {
  return [
    "# Run Summary",
    "",
    `- Run ID: \`${input.runId}\``,
    `- Work Item ID: \`${input.workItemId}\``,
    `- Phase: \`${input.phase}\``,
    `- Status: \`${input.status}\``,
    `- Started At: \`${input.startedAt}\``,
    ...(input.artifactUrl === null ? [] : [`- Artifact Page: ${input.artifactUrl}`]),
    "",
    "# Evidence",
    "",
    "No evidence captured yet.",
    "",
    "# Decision Log",
    "",
    `- Run ledger created at ${input.startedAt}`,
  ].join("\n");
}

function hasArtifactScaffold(markdown: string): boolean {
  if (markdown.trim() === "") {
    return false;
  }

  if (!markdown.includes("# Context")) {
    return false;
  }

  return SECTION_DEFINITIONS.every(
    (section) =>
      markdown.includes(startMarker(section.phase)) &&
      markdown.includes(endMarker(section.phase)),
  ) &&
    markdown.includes(VERIFICATION_SECTION_START) &&
    markdown.includes(VERIFICATION_SECTION_END);
}

function hasRunScaffold(markdown: string): boolean {
  return markdown.includes("# Run Summary") && markdown.includes("# Evidence");
}

function renderDefaultContextSection(workItem: WorkItemRecord): string[] {
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

  return lines;
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

function getSectionDefinition(phase: WorkPhase): ArtifactSectionDefinition {
  const definition = SECTION_DEFINITIONS.find((section) => section.phase === phase);

  if (definition === undefined) {
    throw new Error(`Unsupported phase '${phase}'.`);
  }

  return definition;
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
    return document.replace(
      sectionPattern,
      (_match, prefix: string, body: string, suffix = "") => {
        const trimmedBody = body.trimEnd();
        const sectionBody = trimmedBody.length > 0 ? trimmedBody : fallbackBody;

        return `${prefix}${options.startMarker}\n${sectionBody}\n${options.endMarker}${suffix}`;
      },
    );
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

function createTimestamp(): string {
  return new Date().toISOString();
}

function renderVerificationSection(input: {
  runId: string;
  runUrl: string | null;
  latestSection: string;
  latestTimestamp: string;
}): string {
  return [
    `- Latest evidence run: \`${input.runId}\``,
    ...(input.runUrl === null ? [] : [`- Run ledger page: ${input.runUrl}`]),
    `- Latest evidence update: \`${input.latestTimestamp}\``,
    `- Latest evidence section: ${input.latestSection}`,
    "- Detailed verification output lives on the run ledger page.",
  ].join("\n");
}

function serializeProviderError(error: ProviderError | null): string | null {
  return error === null ? null : JSON.stringify(error);
}

function parseProviderError(value: string | null): ProviderError | null {
  if (value === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);

    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const error = parsed as Record<string, unknown>;

    if (
      typeof error.providerFamily !== "string" ||
      typeof error.providerKind !== "string" ||
      typeof error.code !== "string" ||
      typeof error.message !== "string" ||
      typeof error.retryable !== "boolean"
    ) {
      return null;
    }

    return {
      providerFamily: error.providerFamily as ProviderError["providerFamily"],
      providerKind: error.providerKind,
      code: error.code as ProviderError["code"],
      message: error.message,
      retryable: error.retryable,
      details:
        "details" in error && typeof error.details === "object"
          ? (error.details as ProviderError["details"])
          : null,
    };
  } catch {
    return null;
  }
}

function createMinimalWorkItem(
  workItemId: string,
  overrides: Partial<Pick<WorkItemRecord, "identifier" | "title" | "url">> = {},
): WorkItemRecord {
  const timestamp = createTimestamp();

  return {
    id: workItemId,
    identifier: overrides.identifier === undefined ? workItemId : overrides.identifier,
    title: overrides.title ?? workItemId,
    description: null,
    status: "implement",
    phase: "implement",
    priority: null,
    labels: [],
    url: overrides.url ?? null,
    parentId: null,
    dependencyIds: [],
    blockedByIds: [],
    blocksIds: [],
    artifactUrl: null,
    updatedAt: timestamp,
    createdAt: timestamp,
    orchestration: {
      state: "idle",
      owner: null,
      runId: null,
      leaseUntil: null,
      reviewOutcome: "none",
      blockedReason: null,
      lastError: null,
      attemptCount: 0,
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function describeTargetResolutionError(
  role: NotionTargetRole,
  databaseId: string,
  error: unknown,
): Error {
  if (!(error instanceof NotionRequestError)) {
    return error instanceof Error
      ? error
      : new Error(
          `Failed to validate the Notion ${role} database '${databaseId}'.`,
        );
  }

  switch (error.providerCode) {
    case "auth_invalid":
      return new Error(
        `Notion rejected the configured token while validating the ${role} database '${databaseId}'.`,
      );
    case "not_found":
    case "permission_denied":
      return new Error(
        `Notion ${role} database '${databaseId}' could not be accessed. Make sure the database exists and is shared with the integration.`,
      );
    case "rate_limited":
      return new Error(
        `Notion rate limited startup validation for the ${role} database '${databaseId}'.`,
      );
    case "timeout":
    case "transport":
    case "unavailable":
      return new Error(
        `Notion was temporarily unavailable while validating the ${role} database '${databaseId}'.`,
      );
    default:
      return new Error(
        `Failed to validate the Notion ${role} database '${databaseId}': ${error.message}`,
      );
  }
}
