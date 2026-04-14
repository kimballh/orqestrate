import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseConfig } from "../../config/loader.js";
import type {
  ContextNotionProviderConfig,
  PlanningLocalFilesProviderConfig,
} from "../../config/types.js";
import { bootstrapActiveProfile } from "../../core/bootstrap.js";
import { ProviderRegistry } from "../../core/provider-registry.js";
import type {
  NotionBotUser,
  NotionClientLike,
  NotionCursorPage,
  CreatePageInput,
  NotionDataSource,
  NotionDatabase,
  NotionPage,
  QueryDataSourceInput,
  UpdatePageInput,
  UpdatePageMarkdownInput,
} from "../context/notion-client.js";
import { NotionRequestError, normalizeNotionId } from "../context/notion-client.js";
import { NotionContextBackend } from "../context/notion-backend.js";
import { UnimplementedPlanningBackend } from "../planning/unimplemented-planning-backend.js";
import type { WorkItemRecord } from "../../domain-model.js";

const ARTIFACTS_DATABASE_ID = normalizeNotionId(
  "11111111111111111111111111111111",
);
const RUNS_DATABASE_ID = normalizeNotionId("22222222222222222222222222222222");
const ARTIFACTS_DATA_SOURCE_ID = normalizeNotionId(
  "33333333333333333333333333333333",
);
const RUNS_DATA_SOURCE_ID = normalizeNotionId("44444444444444444444444444444444");
const WORK_ITEM = {
  id: "ORQ-30",
  identifier: "ORQ-30",
  title: "Implement Notion artifact lifecycle and context loading adapter",
  description:
    "Support creation, lookup, and loading of issue artifacts from Notion.",
  status: "implement",
  phase: "implement",
  priority: 2,
  labels: ["backend"],
  url: "https://linear.app/orqestrate/issue/ORQ-30",
  parentId: "ORQ-10",
  dependencyIds: ["ORQ-29"],
  blockedByIds: ["ORQ-16"],
  blocksIds: ["ORQ-31", "ORQ-37"],
  artifactUrl: null,
  updatedAt: "2026-04-14T17:37:54.159Z",
  createdAt: "2026-04-13T23:54:51.359Z",
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

test("validateConfig rejects placeholder database ids", async () => {
  const backend = createBackend({
    artifactsDatabaseId: "replace-me",
  });

  await assert.rejects(
    () => backend.validateConfig(),
    /providers\.notion_main\.artifacts_database_id/,
  );
});

test("validateConfig rejects duplicated database ids", async () => {
  const backend = createBackend({
    runsDatabaseId: ARTIFACTS_DATABASE_ID,
  });

  await assert.rejects(
    () => backend.validateConfig(),
    /different databases for artifacts and runs/i,
  );
});

test("validateConfig fails clearly when the runtime token env var is missing", async () => {
  const backend = createBackend(
    {},
    {
      env: {},
    },
  );

  await assert.rejects(
    () => backend.validateConfig(),
    /Env var 'NOTION_TOKEN' is not set/,
  );
});

test("healthCheck authenticates and resolves both configured data sources", async () => {
  const backend = createBackend(
    {},
    {
      client: new FakeNotionClient({
        databases: {
          [ARTIFACTS_DATABASE_ID]: {
            id: ARTIFACTS_DATABASE_ID,
            title: "Issue Artifacts",
            url: "https://notion.so/artifacts",
            dataSources: [
              {
                id: ARTIFACTS_DATA_SOURCE_ID,
                name: "Issue Artifacts",
              },
            ],
          },
          [RUNS_DATABASE_ID]: {
            id: RUNS_DATABASE_ID,
            title: "Harness Runs",
            url: "https://notion.so/runs",
            dataSources: [
              {
                id: RUNS_DATA_SOURCE_ID,
                name: "Harness Runs",
              },
            ],
          },
        },
        dataSources: {
          [ARTIFACTS_DATA_SOURCE_ID]: createArtifactDataSource({
            url: "https://notion.so/data-source/artifacts",
          }),
          [RUNS_DATA_SOURCE_ID]: createDataSource(
            RUNS_DATA_SOURCE_ID,
            {
              "Run ID": "rich_text",
              Status: "rich_text",
            },
            {
              title: "Harness Runs",
              url: "https://notion.so/data-source/runs",
              parentDatabaseId: RUNS_DATABASE_ID,
            },
          ),
        },
      }),
    },
  );

  await backend.validateConfig();
  const result = await backend.healthCheck();

  assert.equal(result.ok, true);
  assert.match(result.message ?? "", /Authenticated to Notion as 'Orqestrate Bot'/);
  assert.match(result.message ?? "", /validated the artifacts schema/i);
  assert.deepEqual(backend.getResolvedConfig(), {
    tokenEnv: "NOTION_TOKEN",
    token: "notion-token",
    artifactsDatabaseId: ARTIFACTS_DATABASE_ID,
    runsDatabaseId: RUNS_DATABASE_ID,
  });
  assert.deepEqual(backend.getResolvedTargets(), {
    artifacts: {
      role: "artifacts",
      databaseId: ARTIFACTS_DATABASE_ID,
      databaseTitle: "Issue Artifacts",
      databaseUrl: "https://notion.so/artifacts",
      dataSourceId: ARTIFACTS_DATA_SOURCE_ID,
      dataSourceTitle: "Issue Artifacts",
      dataSourceUrl: "https://notion.so/data-source/artifacts",
    },
    runs: {
      role: "runs",
      databaseId: RUNS_DATABASE_ID,
      databaseTitle: "Harness Runs",
      databaseUrl: "https://notion.so/runs",
      dataSourceId: RUNS_DATA_SOURCE_ID,
      dataSourceTitle: "Harness Runs",
      dataSourceUrl: "https://notion.so/data-source/runs",
    },
  });
});

test("healthCheck returns a share hint when a configured database is inaccessible", async () => {
  const backend = createBackend(
    {},
    {
      client: new FakeNotionClient({
        databaseErrors: {
          [ARTIFACTS_DATABASE_ID]: new NotionRequestError("missing access", {
            providerCode: "not_found",
            retryable: false,
          }),
        },
      }),
    },
  );

  await backend.validateConfig();
  const result = await backend.healthCheck();

  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /shared with the integration/i);
});

test("healthCheck fails clearly when a database exposes multiple data sources", async () => {
  const backend = createBackend(
    {},
    {
      client: new FakeNotionClient({
        databases: {
          [ARTIFACTS_DATABASE_ID]: {
            id: ARTIFACTS_DATABASE_ID,
            title: "Issue Artifacts",
            url: null,
            dataSources: [
              { id: ARTIFACTS_DATA_SOURCE_ID, name: "Primary" },
              {
                id: normalizeNotionId("55555555555555555555555555555555"),
                name: "Secondary",
              },
            ],
          },
          [RUNS_DATABASE_ID]: {
            id: RUNS_DATABASE_ID,
            title: "Harness Runs",
            url: null,
            dataSources: [{ id: RUNS_DATA_SOURCE_ID, name: "Harness Runs" }],
          },
        },
        dataSources: {
          [RUNS_DATA_SOURCE_ID]: createDataSource(
            RUNS_DATA_SOURCE_ID,
            {
              "Run ID": "rich_text",
            },
            {
              title: "Harness Runs",
              url: null,
              parentDatabaseId: RUNS_DATABASE_ID,
            },
          ),
        },
      }),
    },
  );

  await backend.validateConfig();
  const result = await backend.healthCheck();

  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /exactly one data source/i);
});

test("healthCheck fails clearly when the artifacts schema is missing required properties", async () => {
  const backend = createBackend(
    {},
    {
      client: new FakeNotionClient({
        databases: {
          [ARTIFACTS_DATABASE_ID]: {
            id: ARTIFACTS_DATABASE_ID,
            title: "Issue Artifacts",
            url: "https://notion.so/artifacts",
            dataSources: [{ id: ARTIFACTS_DATA_SOURCE_ID, name: "Issue Artifacts" }],
          },
          [RUNS_DATABASE_ID]: {
            id: RUNS_DATABASE_ID,
            title: "Harness Runs",
            url: "https://notion.so/runs",
            dataSources: [{ id: RUNS_DATA_SOURCE_ID, name: "Harness Runs" }],
          },
        },
        dataSources: {
          [ARTIFACTS_DATA_SOURCE_ID]: createDataSource(
            ARTIFACTS_DATA_SOURCE_ID,
            {
              Title: "title",
            },
            {
              title: "Issue Artifacts",
              url: "https://notion.so/data-source/artifacts",
              parentDatabaseId: ARTIFACTS_DATABASE_ID,
            },
          ),
          [RUNS_DATA_SOURCE_ID]: createDataSource(
            RUNS_DATA_SOURCE_ID,
            {
              "Run ID": "rich_text",
              Status: "rich_text",
            },
            {
              title: "Harness Runs",
              url: "https://notion.so/data-source/runs",
              parentDatabaseId: RUNS_DATABASE_ID,
            },
          ),
        },
      }),
    },
  );

  await backend.validateConfig();
  const result = await backend.healthCheck();

  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /Linear Issue ID/);
});

test("ensureArtifact creates a durable page once and reuses it on later lookups", async () => {
  const client = createArtifactAwareClient();
  const backend = createBackend({}, { client });

  await backend.validateConfig();

  const first = await backend.ensureArtifact({ workItem: WORK_ITEM });
  const second = await backend.ensureArtifact({ workItem: WORK_ITEM });

  assert.equal(client.createdPageIds.length, 1);
  assert.deepEqual(second, first);
  assert.equal(first.workItemId, WORK_ITEM.id);
  assert.equal(first.phase, "none");
  assert.equal(first.state, "draft");
  assert.equal(first.planReady, false);
  assert.equal(first.reviewSummaryPresent, false);

  const markdown = await client.retrievePageMarkdown(first.artifactId);
  assert.match(markdown.markdown, /^# Context/m);
  assert.match(markdown.markdown, /orqestrate:phase:plan:start/);
});

test("ensureArtifact repairs an existing artifact when the markdown scaffold is missing", async () => {
  const pageId = "page-existing";
  const client = createArtifactAwareClient({
    pages: {
      [pageId]: createArtifactPage({
        id: pageId,
        properties: {
          Title: {
            title: [
              {
                type: "text",
                text: {
                  content: "ORQ-30 - Implement Notion artifact lifecycle and context loading adapter",
                },
              },
            ],
          },
          "Linear Issue ID": {
            rich_text: [
              {
                type: "text",
                text: {
                  content: WORK_ITEM.id,
                },
              },
            ],
          },
          "Current Phase": {
            rich_text: [{ type: "text", text: { content: "none" } }],
          },
          "Artifact State": {
            rich_text: [{ type: "text", text: { content: "draft" } }],
          },
          "Last Updated At": {
            date: { start: "2026-04-14T18:00:00.000Z" },
          },
          "Design Ready": { checkbox: false },
          "Plan Ready": { checkbox: false },
          "Implementation Notes Present": { checkbox: false },
          "Review Summary Present": { checkbox: false },
          "Verification Evidence Present": { checkbox: false },
        },
      }),
    },
    pageMarkdown: {
      [pageId]: "",
    },
  });
  const backend = createBackend({}, { client });

  await backend.validateConfig();

  const artifact = await backend.ensureArtifact({ workItem: WORK_ITEM });
  const markdown = await client.retrievePageMarkdown(pageId);

  assert.equal(client.createdPageIds.length, 0);
  assert.equal(artifact.artifactId, pageId);
  assert.match(markdown.markdown, /^# Context/m);
  assert.match(markdown.markdown, /orqestrate:phase:review:start/);
});

test("writePhaseArtifact updates the managed section and loadContextBundle returns the markdown artifact", async () => {
  const client = createArtifactAwareClient();
  const backend = createBackend({}, { client });

  await backend.validateConfig();

  const artifact = await backend.ensureArtifact({ workItem: WORK_ITEM });
  const updated = await backend.writePhaseArtifact({
    workItem: WORK_ITEM,
    artifact,
    phase: "plan",
    content: "Implementation plan for ORQ-30.",
    summary: "Plan is ready.",
  });
  const storedArtifact = await backend.getArtifactByWorkItemId(WORK_ITEM.id);
  const bundle = await backend.loadContextBundle({
    workItem: WORK_ITEM,
    artifact: storedArtifact,
    phase: "plan",
  });

  assert.equal(updated.phase, "plan");
  assert.equal(updated.state, "ready");
  assert.equal(updated.planReady, true);
  assert.equal(updated.summary, "Plan is ready.");
  assert.ok(storedArtifact);
  assert.equal(storedArtifact.summary, "Plan is ready.");
  assert.match(bundle.contextText, /Implementation plan for ORQ-30\./);
  assert.match(bundle.contextText, /Pending review notes\./);
  assert.deepEqual(bundle.references, [
    {
      kind: "artifact",
      title: updated.title,
      url: updated.url,
    },
  ]);
});

test("bootstraps the notion backend through the shared provider lifecycle with a fake client", async () => {
  const fixture = createFixtureWorkspace();
  const config = parseConfig(
    `version = 1
active_profile = "notion"

[paths]
state_dir = ".harness/state"
data_dir = ".harness/data"
log_dir = ".harness/logs"

[prompts]
root = "./prompts"
active_pack = "default"

[prompt_packs.default]
base_system = "base/system.md"

[providers.local_planning]
kind = "planning.local_files"
root = ".harness/planning"

[providers.notion_main]
kind = "context.notion"
token_env = "NOTION_TOKEN"
artifacts_database_id = "11111111111111111111111111111111"
runs_database_id = "22222222222222222222222222222222"

[profiles.notion]
planning = "local_planning"
context = "notion_main"
`,
    {
      sourcePath: fixture.sourcePath,
      env: {
        NOTION_TOKEN: "notion-token",
      },
    },
  );
  const fakeClient = new FakeNotionClient({
    databases: {
      [ARTIFACTS_DATABASE_ID]: {
        id: ARTIFACTS_DATABASE_ID,
        title: "Issue Artifacts",
        url: null,
        dataSources: [{ id: ARTIFACTS_DATA_SOURCE_ID, name: "Issue Artifacts" }],
      },
      [RUNS_DATABASE_ID]: {
        id: RUNS_DATABASE_ID,
        title: "Harness Runs",
        url: null,
        dataSources: [{ id: RUNS_DATA_SOURCE_ID, name: "Harness Runs" }],
      },
    },
    dataSources: {
      [ARTIFACTS_DATA_SOURCE_ID]: createArtifactDataSource({
        url: null,
      }),
      [RUNS_DATA_SOURCE_ID]: createDataSource(
        RUNS_DATA_SOURCE_ID,
        {
          "Run ID": "rich_text",
        },
        {
          title: "Harness Runs",
          url: null,
          parentDatabaseId: RUNS_DATABASE_ID,
        },
      ),
    },
  });
  const registry = new ProviderRegistry()
    .registerPlanning<PlanningLocalFilesProviderConfig>(
      "planning.local_files",
      ({ provider }) => new FakePlanningBackend(provider),
    )
    .registerContext<ContextNotionProviderConfig>("context.notion", ({ provider }) => {
      return new NotionContextBackend(provider, {
        env: {
          NOTION_TOKEN: "notion-token",
        },
        client: fakeClient,
      });
    });

  const result = await bootstrapActiveProfile(config, { registry });

  assert.ok(result.context instanceof NotionContextBackend);
  assert.equal(result.report.checks[1].validated, true);
  assert.equal(result.report.checks[1].healthCheck?.ok, true);
  assert.deepEqual(result.context.getResolvedTargets(), {
    artifacts: {
      role: "artifacts",
      databaseId: ARTIFACTS_DATABASE_ID,
      databaseTitle: "Issue Artifacts",
      databaseUrl: null,
      dataSourceId: ARTIFACTS_DATA_SOURCE_ID,
      dataSourceTitle: "Issue Artifacts",
      dataSourceUrl: null,
    },
    runs: {
      role: "runs",
      databaseId: RUNS_DATABASE_ID,
      databaseTitle: "Harness Runs",
      databaseUrl: null,
      dataSourceId: RUNS_DATA_SOURCE_ID,
      dataSourceTitle: "Harness Runs",
      dataSourceUrl: null,
    },
  });
});

function createBackend(
  overrides: Partial<ContextNotionProviderConfig>,
  options: {
    env?: NodeJS.ProcessEnv;
    client?: NotionClientLike;
  } = {},
) {
  return new NotionContextBackend(
    {
      name: "notion_main",
      family: "context",
      kind: "context.notion",
      tokenEnv: "NOTION_TOKEN",
      artifactsDatabaseId: ARTIFACTS_DATABASE_ID,
      runsDatabaseId: RUNS_DATABASE_ID,
      ...overrides,
    },
    {
      env: options.env ?? {
        NOTION_TOKEN: "notion-token",
      },
      client: options.client,
    },
  );
}

function createArtifactAwareClient(
  overrides: {
    pages?: Record<string, NotionPage>;
    pageMarkdown?: Record<string, string>;
  } = {},
) {
  return new FakeNotionClient({
    databases: {
      [ARTIFACTS_DATABASE_ID]: {
        id: ARTIFACTS_DATABASE_ID,
        title: "Issue Artifacts",
        url: "https://notion.so/artifacts",
        dataSources: [{ id: ARTIFACTS_DATA_SOURCE_ID, name: "Issue Artifacts" }],
      },
      [RUNS_DATABASE_ID]: {
        id: RUNS_DATABASE_ID,
        title: "Harness Runs",
        url: "https://notion.so/runs",
        dataSources: [{ id: RUNS_DATA_SOURCE_ID, name: "Harness Runs" }],
      },
    },
    dataSources: {
      [ARTIFACTS_DATA_SOURCE_ID]: createArtifactDataSource(),
      [RUNS_DATA_SOURCE_ID]: createDataSource(
        RUNS_DATA_SOURCE_ID,
        {
          "Run ID": "rich_text",
          Status: "rich_text",
        },
        {
          title: "Harness Runs",
          url: "https://notion.so/data-source/runs",
          parentDatabaseId: RUNS_DATABASE_ID,
        },
      ),
    },
    pages: overrides.pages,
    pageMarkdown: overrides.pageMarkdown,
  });
}

function createArtifactDataSource(
  overrides: {
    title?: string | null;
    url?: string | null;
    parentDatabaseId?: string | null;
  } = {},
) {
  return createDataSource(
    ARTIFACTS_DATA_SOURCE_ID,
    {
      Title: "title",
      "Linear Issue ID": "rich_text",
      "Linear URL": "url",
      "Current Phase": "rich_text",
      "Current Status Snapshot": "rich_text",
      "Artifact State": "rich_text",
      "Review Outcome": "rich_text",
      Summary: "rich_text",
      "Last Updated At": "date",
      "Design Ready": "checkbox",
      "Plan Ready": "checkbox",
      "Implementation Notes Present": "checkbox",
      "Review Summary Present": "checkbox",
      "Verification Evidence Present": "checkbox",
    },
    {
      title: "Issue Artifacts",
      url: "https://notion.so/data-source/artifacts",
      parentDatabaseId: ARTIFACTS_DATABASE_ID,
      ...overrides,
    },
  );
}

function createArtifactPage(input: {
  id: string;
  properties: Record<string, unknown>;
}) {
  return {
    id: input.id,
    object: "page",
    url: `https://notion.so/${input.id}`,
    createdTime: "2026-04-14T18:00:00.000Z",
    lastEditedTime: "2026-04-14T18:00:00.000Z",
    parentType: "data_source_id",
    parentId: ARTIFACTS_DATA_SOURCE_ID,
    properties: hydrateProperties(createArtifactDataSource(), input.properties),
  } satisfies NotionPage;
}

function createFixtureWorkspace() {
  const workspaceDir = mkdtempSync(path.join(tmpdir(), "orqestrate-notion-"));
  const promptDir = path.join(workspaceDir, "prompts", "base");
  mkdirSync(promptDir, { recursive: true });
  writeFileSync(
    path.join(promptDir, "system.md"),
    "Base system prompt fixture for Notion bootstrap tests.\n",
  );

  return {
    workspaceDir,
    sourcePath: path.join(workspaceDir, "config.toml"),
  };
}

class FakePlanningBackend extends UnimplementedPlanningBackend<PlanningLocalFilesProviderConfig> {}

class FakeNotionClient implements NotionClientLike {
  private readonly user: NotionBotUser;
  private readonly databases: Record<string, NotionDatabase>;
  private readonly dataSources: Record<string, NotionDataSource>;
  private readonly databaseErrors: Record<string, Error>;
  private readonly pages: Record<string, NotionPage>;
  private readonly pageMarkdown: Record<string, string>;
  private pageSequence: number;
  readonly createdPageIds: string[];

  constructor(options: {
    user?: NotionBotUser;
    databases?: Record<string, NotionDatabase>;
    dataSources?: Record<string, NotionDataSource>;
    databaseErrors?: Record<string, Error>;
    pages?: Record<string, NotionPage>;
    pageMarkdown?: Record<string, string>;
  } = {}) {
    this.user = options.user ?? {
      id: "bot-user",
      name: "Orqestrate Bot",
      type: "bot",
      workspaceName: "Orqestrate",
      ownerType: "workspace",
    };
    this.databases = options.databases ?? {};
    this.dataSources = options.dataSources ?? {};
    this.databaseErrors = options.databaseErrors ?? {};
    this.pages = options.pages ?? {};
    this.pageMarkdown = options.pageMarkdown ?? {};
    this.pageSequence = Object.keys(this.pages).length + 1;
    this.createdPageIds = [];
  }

  async getTokenBotUser(): Promise<NotionBotUser> {
    return this.user;
  }

  async retrieveDatabase(databaseId: string): Promise<NotionDatabase> {
    const error = this.databaseErrors[databaseId];

    if (error !== undefined) {
      throw error;
    }

    const database = this.databases[databaseId];

    if (database === undefined) {
      throw new Error(`Unexpected database lookup: ${databaseId}`);
    }

    return database;
  }

  async retrieveDataSource(dataSourceId: string): Promise<NotionDataSource> {
    const dataSource = this.dataSources[dataSourceId];

    if (dataSource === undefined) {
      throw new Error(`Unexpected data source lookup: ${dataSourceId}`);
    }

    return dataSource;
  }

  async queryDataSource<T = unknown>(
    _input: QueryDataSourceInput,
  ): Promise<NotionCursorPage<T>> {
    return {
      object: "list",
      results: [],
      nextCursor: null,
      hasMore: false,
    };
  }

  async queryDataSourcePages(
    input: QueryDataSourceInput,
  ): Promise<NotionCursorPage<NotionPage>> {
    const results = Object.values(this.pages).filter((page) => {
      if (page.parentId !== input.dataSourceId) {
        return false;
      }

      if (input.filter === undefined) {
        return true;
      }

      return matchesFilter(page, input.filter);
    });

    return {
      object: "list",
      results,
      nextCursor: null,
      hasMore: false,
    };
  }

  async createPage(input: CreatePageInput): Promise<NotionPage> {
    const parentId =
      typeof input.parent.data_source_id === "string"
        ? input.parent.data_source_id
        : null;
    const dataSource =
      parentId === null ? undefined : this.dataSources[parentId];
    const id = `page-${this.pageSequence++}`;
    const page: NotionPage = {
      id,
      object: "page",
      url: `https://notion.so/${id}`,
      createdTime: "2026-04-14T18:00:00.000Z",
      lastEditedTime: "2026-04-14T18:00:00.000Z",
      parentType: "data_source_id",
      parentId,
      properties:
        dataSource === undefined
          ? input.properties ?? {}
          : hydrateProperties(dataSource, input.properties ?? {}),
    };

    this.pages[id] = page;
    this.pageMarkdown[id] = "";
    this.createdPageIds.push(id);

    return page;
  }

  async updatePage(pageId: string, input: UpdatePageInput): Promise<NotionPage> {
    const current = this.pages[pageId];

    if (current === undefined) {
      throw new Error(`Unexpected page update: ${pageId}`);
    }

    const dataSource =
      current.parentId === null ? undefined : this.dataSources[current.parentId];

    const updated: NotionPage = {
      ...current,
      lastEditedTime: "2026-04-14T18:05:00.000Z",
      properties:
        input.properties === undefined || dataSource === undefined
          ? current.properties
          : {
              ...current.properties,
              ...hydrateProperties(dataSource, input.properties),
            },
    };

    this.pages[pageId] = updated;

    return updated;
  }

  async retrievePageMarkdown(pageId: string): Promise<{
    object: string | null;
    id: string;
    markdown: string;
    truncated: boolean;
    unknownBlockIds: string[];
  }> {
    if (!(pageId in this.pageMarkdown)) {
      throw new Error(`Unexpected markdown lookup: ${pageId}`);
    }

    return {
      object: "page_markdown",
      id: pageId,
      markdown: this.pageMarkdown[pageId] ?? "",
      truncated: false,
      unknownBlockIds: [],
    };
  }

  async updatePageMarkdown(
    pageId: string,
    input: UpdatePageMarkdownInput,
  ): Promise<{
    object: string | null;
    id: string;
    markdown: string;
    truncated: boolean;
    unknownBlockIds: string[];
  }> {
    if (input.type !== "replace_content") {
      throw new Error("FakeNotionClient only supports replace_content in tests.");
    }

    this.pageMarkdown[pageId] = input.newString;
    return this.retrievePageMarkdown(pageId);
  }

  async appendBlockChildren<T = unknown>(): Promise<NotionCursorPage<T>> {
    return {
      object: "list",
      results: [],
      nextCursor: null,
      hasMore: false,
    };
  }

  async search<T = unknown>(): Promise<NotionCursorPage<T>> {
    return {
      object: "list",
      results: [],
      nextCursor: null,
      hasMore: false,
    };
  }
}

function createDataSource(
  id: string,
  properties: Record<string, string>,
  options: {
    title?: string | null;
    url?: string | null;
    parentDatabaseId?: string | null;
  } = {},
): NotionDataSource {
  return {
    id,
    title:
      options.title ??
      (id === ARTIFACTS_DATA_SOURCE_ID ? "Issue Artifacts" : "Harness Runs"),
    url:
      options.url === undefined
        ? `https://notion.so/data-source/${id}`
        : options.url,
    parentDatabaseId:
      options.parentDatabaseId ??
      (id === ARTIFACTS_DATA_SOURCE_ID ? ARTIFACTS_DATABASE_ID : RUNS_DATABASE_ID),
    propertyNames: Object.keys(properties),
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, type]) => [
        name,
        {
          id: name.toLowerCase().replace(/\s+/g, "-"),
          type,
        },
      ]),
    ),
  };
}

function matchesFilter(page: NotionPage, filter: Record<string, unknown>): boolean {
  const property = typeof filter.property === "string" ? filter.property : null;

  if (property === null) {
    return true;
  }

  if ("rich_text" in filter) {
    const condition = filter.rich_text;

    if (typeof condition !== "object" || condition === null) {
      return false;
    }

    const equals = (condition as Record<string, unknown>).equals;
    return readRichTextProperty(page.properties[property]) === equals;
  }

  return false;
}

function hydrateProperties(
  dataSource: NotionDataSource,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties).map(([name, value]) => {
      const property = dataSource.properties[name];
      const propertyType = property?.type ?? "unknown";

      return [
        name,
        {
          id: property?.id ?? name,
          type: propertyType,
          ...(typeof value === "object" && value !== null
            ? (value as Record<string, unknown>)
            : {}),
        },
      ];
    }),
  );
}

function readRichTextProperty(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const richText = (value as Record<string, unknown>).rich_text;

  if (!Array.isArray(richText)) {
    return null;
  }

  return richText
    .map((part) => {
      if (typeof part !== "object" || part === null) {
        return "";
      }

      const text = (part as Record<string, unknown>).text;

      if (typeof text !== "object" || text === null) {
        return "";
      }

      const content = (text as Record<string, unknown>).content;
      return typeof content === "string" ? content : "";
    })
    .join("");
}
