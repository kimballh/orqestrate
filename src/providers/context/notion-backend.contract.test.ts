import type { ContextNotionProviderConfig } from "../../config/types.js";
import { defineContextBackendContract } from "../../test/contracts/context-backend-contract.js";

import type {
  CreatePageInput,
  NotionBotUser,
  NotionClientLike,
  NotionCursorPage,
  NotionDataSource,
  NotionDatabase,
  NotionPage,
  QueryDataSourceInput,
  UpdatePageInput,
  UpdatePageMarkdownInput,
} from "./notion-client.js";
import { normalizeNotionId } from "./notion-client.js";
import { NotionContextBackend } from "./notion-backend.js";

const ARTIFACTS_DATABASE_ID = normalizeNotionId(
  "11111111111111111111111111111111",
);
const RUNS_DATABASE_ID = normalizeNotionId("22222222222222222222222222222222");
const ARTIFACTS_DATA_SOURCE_ID = normalizeNotionId(
  "33333333333333333333333333333333",
);
const RUNS_DATA_SOURCE_ID = normalizeNotionId("44444444444444444444444444444444");

defineContextBackendContract({
  providerName: "context.notion",
  async setup() {
    const backend = createBackend({}, { client: createContractClient() });
    await backend.validateConfig();

    return {
      backend,
    };
  },
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

function createContractClient() {
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
        {},
        {
          title: "Harness Runs",
          url: "https://notion.so/data-source/runs",
          parentDatabaseId: RUNS_DATABASE_ID,
        },
      ),
    },
  });
}

function createArtifactDataSource() {
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
    },
  );
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
  const normalizedProperties =
    id === RUNS_DATA_SOURCE_ID
      ? {
          ...createRunDataSourceProperties(),
          ...properties,
        }
      : properties;

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
    propertyNames: Object.keys(normalizedProperties),
    properties: Object.fromEntries(
      Object.entries(normalizedProperties).map(([name, type]) => [
        name,
        {
          id: name.toLowerCase().replace(/\s+/g, "-"),
          type,
        },
      ]),
    ),
  };
}

function createRunDataSourceProperties(): Record<string, string> {
  return {
    Title: "title",
    "Run ID": "rich_text",
    "Linear Issue ID": "rich_text",
    "Linear URL": "url",
    Phase: "rich_text",
    Status: "rich_text",
    "Started At": "date",
    "Ended At": "date",
    "Artifact Page": "rich_text",
    Summary: "rich_text",
    Error: "rich_text",
  };
}

class FakeNotionClient implements NotionClientLike {
  private readonly user: NotionBotUser;
  private readonly databases: Record<string, NotionDatabase>;
  private readonly dataSources: Record<string, NotionDataSource>;
  private readonly pages: Record<string, NotionPage>;
  private readonly pageMarkdown: Record<string, string>;
  private pageSequence: number;

  constructor(options: {
    user?: NotionBotUser;
    databases?: Record<string, NotionDatabase>;
    dataSources?: Record<string, NotionDataSource>;
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
    this.pages = options.pages ?? {};
    this.pageMarkdown = options.pageMarkdown ?? {};
    this.pageSequence = Object.keys(this.pages).length + 1;
  }

  async getTokenBotUser(): Promise<NotionBotUser> {
    return this.user;
  }

  async retrieveDatabase(databaseId: string): Promise<NotionDatabase> {
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

  async queryDataSourcePages(
    input: QueryDataSourceInput,
  ): Promise<NotionCursorPage<NotionPage>> {
    let results = Object.values(this.pages).filter((page) => {
      if (page.parentId !== input.dataSourceId) {
        return false;
      }

      if (input.filter === undefined) {
        return true;
      }

      return matchesFilter(page, input.filter);
    });

    if (Array.isArray(input.sorts) && input.sorts.length > 0) {
      results = sortPages(results, input.sorts);
    }

    const startIndex =
      input.startCursor === undefined ? 0 : Number.parseInt(input.startCursor, 10) || 0;
    const pageSize = input.pageSize ?? results.length;
    const pagedResults = results.slice(startIndex, startIndex + pageSize);
    const nextIndex = startIndex + pagedResults.length;

    return {
      object: "list",
      results: pagedResults,
      nextCursor: nextIndex < results.length ? String(nextIndex) : null,
      hasMore: nextIndex < results.length,
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

function sortPages(
  pages: NotionPage[],
  sorts: Array<Record<string, unknown>>,
): NotionPage[] {
  return [...pages].sort((left, right) => {
    for (const sort of sorts) {
      const property = typeof sort.property === "string" ? sort.property : null;
      const direction = sort.direction === "descending" ? -1 : 1;

      if (property === null) {
        continue;
      }

      const leftValue = sortablePropertyValue(left.properties[property]);
      const rightValue = sortablePropertyValue(right.properties[property]);

      if (leftValue < rightValue) {
        return -1 * direction;
      }

      if (leftValue > rightValue) {
        return 1 * direction;
      }
    }

    return 0;
  });
}

function sortablePropertyValue(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return "";
  }

  const property = value as Record<string, unknown>;

  if (property.type === "date") {
    const date = property.date as Record<string, unknown> | null;
    return typeof date?.start === "string" ? date.start : "";
  }

  return readRichTextProperty(value) ?? "";
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
