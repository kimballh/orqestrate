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
  NotionDataSource,
  NotionDatabase,
  NotionPage,
} from "../context/notion-client.js";
import { NotionRequestError, normalizeNotionId } from "../context/notion-client.js";
import { NotionContextBackend } from "../context/notion-backend.js";
import { UnimplementedPlanningBackend } from "../planning/unimplemented-planning-backend.js";

const ARTIFACTS_DATABASE_ID = normalizeNotionId(
  "11111111111111111111111111111111",
);
const RUNS_DATABASE_ID = normalizeNotionId("22222222222222222222222222222222");
const ARTIFACTS_DATA_SOURCE_ID = normalizeNotionId(
  "33333333333333333333333333333333",
);
const RUNS_DATA_SOURCE_ID = normalizeNotionId("44444444444444444444444444444444");

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
          [ARTIFACTS_DATA_SOURCE_ID]: {
            id: ARTIFACTS_DATA_SOURCE_ID,
            title: "Issue Artifacts",
            url: "https://notion.so/data-source/artifacts",
            parentDatabaseId: ARTIFACTS_DATABASE_ID,
            propertyNames: ["Title", "Linear Issue ID"],
          },
          [RUNS_DATA_SOURCE_ID]: {
            id: RUNS_DATA_SOURCE_ID,
            title: "Harness Runs",
            url: "https://notion.so/data-source/runs",
            parentDatabaseId: RUNS_DATABASE_ID,
            propertyNames: ["Run ID", "Status"],
          },
        },
      }),
    },
  );

  await backend.validateConfig();
  const result = await backend.healthCheck();

  assert.equal(result.ok, true);
  assert.match(result.message ?? "", /Authenticated to Notion as 'Orqestrate Bot'/);
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
          [RUNS_DATA_SOURCE_ID]: {
            id: RUNS_DATA_SOURCE_ID,
            title: "Harness Runs",
            url: null,
            parentDatabaseId: RUNS_DATABASE_ID,
            propertyNames: [],
          },
        },
      }),
    },
  );

  await backend.validateConfig();
  const result = await backend.healthCheck();

  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /exactly one data source/i);
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
      [ARTIFACTS_DATA_SOURCE_ID]: {
        id: ARTIFACTS_DATA_SOURCE_ID,
        title: "Issue Artifacts",
        url: null,
        parentDatabaseId: ARTIFACTS_DATABASE_ID,
        propertyNames: [],
      },
      [RUNS_DATA_SOURCE_ID]: {
        id: RUNS_DATA_SOURCE_ID,
        title: "Harness Runs",
        url: null,
        parentDatabaseId: RUNS_DATABASE_ID,
        propertyNames: [],
      },
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

  constructor(options: {
    user?: NotionBotUser;
    databases?: Record<string, NotionDatabase>;
    dataSources?: Record<string, NotionDataSource>;
    databaseErrors?: Record<string, Error>;
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

  async queryDataSource<T = unknown>(): Promise<NotionCursorPage<T>> {
    return {
      object: "list",
      results: [],
      nextCursor: null,
      hasMore: false,
    };
  }

  async createPage(): Promise<NotionPage> {
    return {
      id: "page",
      object: "page",
      url: null,
      parentType: null,
      parentId: null,
      properties: {},
    };
  }

  async updatePage(): Promise<NotionPage> {
    return {
      id: "page",
      object: "page",
      url: null,
      parentType: null,
      parentId: null,
      properties: {},
    };
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
