import type { ProviderErrorCode } from "../../domain-model.js";

export const NOTION_API_VERSION = "2026-03-11";

const DEFAULT_BASE_URL = "https://api.notion.com/v1";
const DEFAULT_TIMEOUT_MS = 15_000;
const UUID_HEX_PATTERN = /^[0-9a-f]{32}$/i;
const UUID_DASHED_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type NotionRichText = {
  plain_text?: string | null;
  text?: {
    content?: string | null;
  };
};

type NotionErrorResponse = {
  code?: string;
  message?: string;
};

type NotionUserResponse = {
  id: string;
  name?: string | null;
  type?: string;
  bot?: {
    workspace_name?: string | null;
    owner?: {
      type?: string;
    };
  };
};

type NotionDatabaseResponse = {
  id: string;
  url?: string | null;
  title?: NotionRichText[];
  data_sources?: Array<{
    id: string;
    name?: string | NotionRichText[] | null;
  }>;
};

type NotionDataSourceResponse = {
  id: string;
  url?: string | null;
  title?: NotionRichText[];
  parent?: {
    type?: string;
    database_id?: string;
  };
  properties?: Record<string, unknown>;
};

type CursorResponse<T> = {
  object?: string;
  results?: T[];
  next_cursor?: string | null;
  has_more?: boolean;
};

type NotionPageResponse = {
  object?: string;
  id: string;
  url?: string | null;
  properties?: Record<string, unknown>;
  parent?: {
    type?: string;
    data_source_id?: string;
    database_id?: string;
    page_id?: string;
  };
};

export type NotionBotUser = {
  id: string;
  name: string | null;
  type: string | null;
  workspaceName: string | null;
  ownerType: string | null;
};

export type NotionDatabaseDataSource = {
  id: string;
  name: string | null;
};

export type NotionDatabase = {
  id: string;
  title: string | null;
  url: string | null;
  dataSources: NotionDatabaseDataSource[];
};

export type NotionDataSource = {
  id: string;
  title: string | null;
  url: string | null;
  parentDatabaseId: string | null;
  propertyNames: string[];
};

export type NotionPage = {
  id: string;
  object: string | null;
  url: string | null;
  parentType: string | null;
  parentId: string | null;
  properties: Record<string, unknown>;
};

export type NotionCursorPage<T> = {
  object: string | null;
  results: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type NotionClientOptions = {
  authToken: string;
  baseUrl?: string;
  notionVersion?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
};

export type QueryDataSourceInput = {
  dataSourceId: string;
  filter?: Record<string, unknown>;
  sorts?: Array<Record<string, unknown>>;
  startCursor?: string;
  pageSize?: number;
};

export type CreatePageInput = {
  parent: Record<string, unknown>;
  properties?: Record<string, unknown>;
  children?: unknown[];
  icon?: Record<string, unknown>;
  cover?: Record<string, unknown>;
};

export type UpdatePageInput = {
  properties?: Record<string, unknown>;
  inTrash?: boolean;
  icon?: Record<string, unknown> | null;
  cover?: Record<string, unknown> | null;
};

export type AppendBlockPosition =
  | {
      type: "start" | "end";
    }
  | {
      type: "after_block";
      afterBlockId: string;
    };

export type AppendBlockChildrenInput = {
  children: unknown[];
  position?: AppendBlockPosition;
};

export type SearchInput = {
  query?: string;
  sort?: Record<string, unknown>;
  filter?: Record<string, unknown>;
  startCursor?: string;
  pageSize?: number;
};

export interface NotionClientLike {
  getTokenBotUser(): Promise<NotionBotUser>;
  retrieveDatabase(databaseId: string): Promise<NotionDatabase>;
  retrieveDataSource(dataSourceId: string): Promise<NotionDataSource>;
  queryDataSource<T = unknown>(
    input: QueryDataSourceInput,
  ): Promise<NotionCursorPage<T>>;
  createPage(input: CreatePageInput): Promise<NotionPage>;
  updatePage(pageId: string, input: UpdatePageInput): Promise<NotionPage>;
  appendBlockChildren<T = unknown>(
    blockId: string,
    input: AppendBlockChildrenInput,
  ): Promise<NotionCursorPage<T>>;
  search<T = unknown>(input: SearchInput): Promise<NotionCursorPage<T>>;
}

type NotionRequestErrorOptions = {
  status?: number;
  notionCode?: string | null;
  providerCode: ProviderErrorCode;
  retryable: boolean;
};

export class NotionRequestError extends Error {
  readonly status?: number;
  readonly notionCode?: string | null;
  readonly providerCode: ProviderErrorCode;
  readonly retryable: boolean;

  constructor(message: string, options: NotionRequestErrorOptions) {
    super(message);
    this.name = "NotionRequestError";
    this.status = options.status;
    this.notionCode = options.notionCode;
    this.providerCode = options.providerCode;
    this.retryable = options.retryable;
  }
}

export class NotionClient implements NotionClientLike {
  private readonly authToken: string;
  private readonly baseUrl: string;
  private readonly notionVersion: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: NotionClientOptions) {
    this.authToken = options.authToken;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.notionVersion = options.notionVersion ?? NOTION_API_VERSION;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetcher = options.fetcher ?? fetch;
  }

  async getTokenBotUser(): Promise<NotionBotUser> {
    const response = await this.request<NotionUserResponse>("/users/me", {
      method: "GET",
    });

    return {
      id: response.id,
      name: response.name ?? null,
      type: response.type ?? null,
      workspaceName: response.bot?.workspace_name ?? null,
      ownerType: response.bot?.owner?.type ?? null,
    };
  }

  async retrieveDatabase(databaseId: string): Promise<NotionDatabase> {
    const response = await this.request<NotionDatabaseResponse>(
      `/databases/${databaseId}`,
      {
        method: "GET",
      },
    );

    return {
      id: response.id,
      title: richTextToPlainText(response.title),
      url: response.url ?? null,
      dataSources: (response.data_sources ?? []).map((dataSource) => ({
        id: dataSource.id,
        name: normalizeDatabaseDataSourceName(dataSource.name),
      })),
    };
  }

  async retrieveDataSource(dataSourceId: string): Promise<NotionDataSource> {
    const response = await this.request<NotionDataSourceResponse>(
      `/data_sources/${dataSourceId}`,
      {
        method: "GET",
      },
    );

    return {
      id: response.id,
      title: richTextToPlainText(response.title),
      url: response.url ?? null,
      parentDatabaseId:
        response.parent?.type === "database_id"
          ? response.parent.database_id ?? null
          : null,
      propertyNames: Object.keys(response.properties ?? {}),
    };
  }

  async queryDataSource<T = unknown>(
    input: QueryDataSourceInput,
  ): Promise<NotionCursorPage<T>> {
    const response = await this.request<CursorResponse<T>>(
      `/data_sources/${input.dataSourceId}/query`,
      {
        method: "POST",
        body: {
          ...(input.filter === undefined ? {} : { filter: input.filter }),
          ...(input.sorts === undefined ? {} : { sorts: input.sorts }),
          ...(input.startCursor === undefined
            ? {}
            : { start_cursor: input.startCursor }),
          ...(input.pageSize === undefined ? {} : { page_size: input.pageSize }),
        },
      },
    );

    return normalizeCursorResponse(response);
  }

  async createPage(input: CreatePageInput): Promise<NotionPage> {
    const response = await this.request<NotionPageResponse>("/pages", {
      method: "POST",
      body: input,
    });

    return normalizePage(response);
  }

  async updatePage(pageId: string, input: UpdatePageInput): Promise<NotionPage> {
    const response = await this.request<NotionPageResponse>(`/pages/${pageId}`, {
      method: "PATCH",
      body: {
        ...(input.properties === undefined
          ? {}
          : { properties: input.properties }),
        ...(input.inTrash === undefined ? {} : { in_trash: input.inTrash }),
        ...(input.icon === undefined ? {} : { icon: input.icon }),
        ...(input.cover === undefined ? {} : { cover: input.cover }),
      },
    });

    return normalizePage(response);
  }

  async appendBlockChildren<T = unknown>(
    blockId: string,
    input: AppendBlockChildrenInput,
  ): Promise<NotionCursorPage<T>> {
    const response = await this.request<CursorResponse<T>>(
      `/blocks/${blockId}/children`,
      {
        method: "PATCH",
        body: {
          children: input.children,
          ...(input.position === undefined
            ? {}
            : { position: serializeAppendBlockPosition(input.position) }),
        },
      },
    );

    return normalizeCursorResponse(response);
  }

  async search<T = unknown>(input: SearchInput): Promise<NotionCursorPage<T>> {
    const response = await this.request<CursorResponse<T>>("/search", {
      method: "POST",
      body: {
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.sort === undefined ? {} : { sort: input.sort }),
        ...(input.filter === undefined ? {} : { filter: input.filter }),
        ...(input.startCursor === undefined
          ? {}
          : { start_cursor: input.startCursor }),
        ...(input.pageSize === undefined ? {} : { page_size: input.pageSize }),
      },
    });

    return normalizeCursorResponse(response);
  }

  private async request<T>(
    path: string,
    init: {
      method: "GET" | "POST" | "PATCH";
      body?: unknown;
    },
  ): Promise<T> {
    const headers = new Headers({
      Authorization: `Bearer ${this.authToken}`,
      "Notion-Version": this.notionVersion,
    });

    let response: Response;

    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: init.method,
        headers:
          init.body === undefined
            ? headers
            : new Headers({
                ...Object.fromEntries(headers.entries()),
                "Content-Type": "application/json",
              }),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw normalizeTransportError(error, init.method, path);
    }

    const text = await response.text();
    const payload = safeJsonParse(text);

    if (!response.ok) {
      throw normalizeHttpError(response.status, payload, init.method, path);
    }

    return payload as T;
  }
}

export function normalizeNotionId(raw: string): string {
  const trimmed = raw.trim();

  if (UUID_DASHED_PATTERN.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  const compact = trimmed.replace(/-/g, "");

  if (!UUID_HEX_PATTERN.test(compact)) {
    throw new Error(
      "Expected a Notion ID formatted as 32 hexadecimal characters or a dashed UUID.",
    );
  }

  const normalized = compact.toLowerCase();

  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`;
}

function normalizeDatabaseDataSourceName(
  value: string | NotionRichText[] | null | undefined,
): string | null {
  if (typeof value === "string") {
    return value.trim() === "" ? null : value;
  }

  return richTextToPlainText(value);
}

function normalizePage(response: NotionPageResponse): NotionPage {
  let parentId: string | null = null;

  if (response.parent?.type === "data_source_id") {
    parentId = response.parent.data_source_id ?? null;
  } else if (response.parent?.type === "database_id") {
    parentId = response.parent.database_id ?? null;
  } else if (response.parent?.type === "page_id") {
    parentId = response.parent.page_id ?? null;
  }

  return {
    id: response.id,
    object: response.object ?? null,
    url: response.url ?? null,
    parentType: response.parent?.type ?? null,
    parentId,
    properties: response.properties ?? {},
  };
}

function normalizeCursorResponse<T>(
  response: CursorResponse<T>,
): NotionCursorPage<T> {
  return {
    object: response.object ?? null,
    results: response.results ?? [],
    nextCursor: response.next_cursor ?? null,
    hasMore: response.has_more ?? false,
  };
}

function richTextToPlainText(value: NotionRichText[] | null | undefined): string | null {
  if (value === undefined || value === null || value.length === 0) {
    return null;
  }

  const plainText = value
    .map((part) => part.plain_text ?? part.text?.content ?? "")
    .join("")
    .trim();

  return plainText === "" ? null : plainText;
}

function serializeAppendBlockPosition(
  position: AppendBlockPosition,
): Record<string, unknown> {
  if (position.type === "after_block") {
    return {
      type: "after_block",
      after_block: {
        id: position.afterBlockId,
      },
    };
  }

  return {
    type: position.type,
  };
}

function safeJsonParse(text: string): unknown {
  if (text.trim() === "") {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function normalizeHttpError(
  status: number,
  payload: unknown,
  method: string,
  path: string,
): NotionRequestError {
  const errorPayload = isNotionErrorResponse(payload) ? payload : undefined;
  const notionCode = errorPayload?.code ?? null;
  const suffix =
    errorPayload?.message === undefined ? "" : ` ${errorPayload.message}`;

  switch (notionCode) {
    case "unauthorized":
      return new NotionRequestError(
        `Notion rejected the configured API token.${suffix}`.trim(),
        {
          status,
          notionCode,
          providerCode: "auth_invalid",
          retryable: false,
        },
      );
    case "restricted_resource":
      return new NotionRequestError(
        `Notion denied access to the requested resource.${suffix}`.trim(),
        {
          status,
          notionCode,
          providerCode: "permission_denied",
          retryable: false,
        },
      );
    case "object_not_found":
      return new NotionRequestError(
        `The requested Notion resource was not found or is not shared with the integration.${suffix}`.trim(),
        {
          status,
          notionCode,
          providerCode: "not_found",
          retryable: false,
        },
      );
    case "validation_error":
      return new NotionRequestError(
        `Notion rejected the request payload.${suffix}`.trim(),
        {
          status,
          notionCode,
          providerCode: "validation",
          retryable: false,
        },
      );
    case "rate_limited":
      return new NotionRequestError(
        `Notion rate limited the request.${suffix}`.trim(),
        {
          status,
          notionCode,
          providerCode: "rate_limited",
          retryable: true,
        },
      );
    case "conflict_error":
      return new NotionRequestError(
        `Notion reported a request conflict.${suffix}`.trim(),
        {
          status,
          notionCode,
          providerCode: "conflict",
          retryable: true,
        },
      );
  }

  if ([502, 503, 504].includes(status)) {
    return new NotionRequestError(
      `Notion is temporarily unavailable while handling ${method} ${path}.${suffix}`.trim(),
      {
        status,
        notionCode,
        providerCode: "unavailable",
        retryable: true,
      },
    );
  }

  return new NotionRequestError(
    `Notion request ${method} ${path} failed with status ${status}.${suffix}`.trim(),
    {
      status,
      notionCode,
      providerCode: status >= 500 ? "unavailable" : "unknown",
      retryable: status >= 500,
    },
  );
}

function normalizeTransportError(
  error: unknown,
  method: string,
  path: string,
): NotionRequestError {
  if (isTimeoutError(error)) {
    return new NotionRequestError(
      `Notion request ${method} ${path} timed out.`,
      {
        providerCode: "timeout",
        retryable: true,
      },
    );
  }

  return new NotionRequestError(
    `Notion request ${method} ${path} failed before a response was received.${errorMessageSuffix(error)}`,
    {
      providerCode: "transport",
      retryable: true,
    },
  );
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      /timed out/i.test(error.message))
  );
}

function errorMessageSuffix(error: unknown): string {
  if (!(error instanceof Error) || error.message.trim() === "") {
    return "";
  }

  return ` ${error.message}`;
}

function isNotionErrorResponse(value: unknown): value is NotionErrorResponse {
  return typeof value === "object" && value !== null;
}
