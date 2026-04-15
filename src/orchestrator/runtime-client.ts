import http from "node:http";

import type { LoadedConfig } from "../config/types.js";
import { resolveRuntimeConfig } from "../runtime/config.js";
import { resolveRuntimeApiListenOptions } from "../runtime/api/server.js";
import type {
  CreateRunResponse,
  ErrorResponse,
  EventsResponse,
  GetRunResponse,
  HealthResponse,
  ListRunsQuery,
  ListRunsResponse,
  ListRunEventsQuery,
  RuntimeApiListenOptions,
  RuntimeApiRun,
} from "../runtime/api/types.js";
import type { RunSubmissionPayload } from "../domain-model.js";
import type { RunEventRecord } from "../runtime/types.js";
import type { RuntimeReadinessSnapshot } from "../runtime/types.js";

export type RuntimeClient = {
  createRun(payload: RunSubmissionPayload): Promise<CreateRunResponse>;
  getRun(runId: string): Promise<RuntimeApiRun>;
  listRuns(query?: ListRunsQuery): Promise<ListRunsResponse>;
  listRunEvents(
    runId: string,
    query?: ListRunEventsQuery,
  ): Promise<RunEventRecord[]>;
  getHealth(): Promise<RuntimeReadinessSnapshot>;
};

export class RuntimeApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = "RuntimeApiClientError";
    this.status = input.status;
    this.code = input.code;
    this.retryable = input.retryable ?? false;
  }
}

export type RuntimeApiClientOptions = {
  listenOptions: RuntimeApiListenOptions;
  requestTimeoutMs?: number;
};

export class HttpRuntimeApiClient implements RuntimeClient {
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: RuntimeApiClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async createRun(payload: RunSubmissionPayload): Promise<CreateRunResponse> {
    return this.requestJson<CreateRunResponse>({
      method: "POST",
      pathname: "/v1/runs",
      body: payload,
    });
  }

  async getRun(runId: string): Promise<RuntimeApiRun> {
    const response = await this.requestJson<GetRunResponse>({
      method: "GET",
      pathname: `/v1/runs/${encodeURIComponent(runId)}`,
    });
    return response.run;
  }

  async listRuns(query: ListRunsQuery = {}): Promise<ListRunsResponse> {
    const params = new URLSearchParams();

    if (query.status !== undefined) {
      params.set("status", query.status);
    }
    if (query.provider !== undefined) {
      params.set("provider", query.provider);
    }
    if (query.workItemId !== undefined) {
      params.set("workItemId", query.workItemId);
    }
    if (query.phase !== undefined) {
      params.set("phase", query.phase);
    }
    if (query.repoRoot !== undefined) {
      params.set("repoRoot", query.repoRoot);
    }
    if (query.limit !== undefined) {
      params.set("limit", String(query.limit));
    }
    if (query.cursor !== undefined) {
      params.set("cursor", query.cursor);
    }

    return this.requestJson<ListRunsResponse>({
      method: "GET",
      pathname: `/v1/runs${params.size === 0 ? "" : `?${params.toString()}`}`,
    });
  }

  async listRunEvents(
    runId: string,
    query: ListRunEventsQuery = {},
  ): Promise<RunEventRecord[]> {
    const params = new URLSearchParams();
    if (query.after !== undefined) {
      params.set("after", String(query.after));
    }
    if (query.limit !== undefined) {
      params.set("limit", String(query.limit));
    }
    if (query.waitMs !== undefined) {
      params.set("waitMs", String(query.waitMs));
    }

    const response = await this.requestJson<EventsResponse>({
      method: "GET",
      pathname: `/v1/runs/${encodeURIComponent(runId)}/events${params.size === 0 ? "" : `?${params.toString()}`}`,
    });
    return response.events;
  }

  async getHealth(): Promise<RuntimeReadinessSnapshot> {
    return this.requestJson<HealthResponse>({
      method: "GET",
      pathname: "/v1/health",
    });
  }

  private async requestJson<T>(input: {
    method: "GET" | "POST";
    pathname: string;
    body?: unknown;
  }): Promise<T> {
    const body =
      input.body === undefined ? undefined : JSON.stringify(input.body);
    const response = await new Promise<{
      status: number;
      body: string;
    }>((resolve, reject) => {
      const request = http.request(
        buildRequestOptions(this.options.listenOptions, input, body),
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.from(chunk));
          });
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 500,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );

      request.setTimeout(this.requestTimeoutMs, () => {
        request.destroy(
          new RuntimeApiClientError({
            status: 504,
            code: "timeout",
            message: `Runtime API request timed out after ${this.requestTimeoutMs}ms.`,
            retryable: true,
          }),
        );
      });
      request.on("error", reject);

      if (body !== undefined) {
        request.write(body);
      }

      request.end();
    });

    const parsed = response.body.length === 0 ? null : JSON.parse(response.body);
    if (response.status >= 400) {
      const error = parsed as ErrorResponse | null;
      throw new RuntimeApiClientError({
        status: response.status,
        code: error?.error.code ?? "runtime_api_error",
        message: error?.error.message ?? "Runtime API request failed.",
        retryable: error?.error.retryable ?? response.status >= 500,
      });
    }

    return parsed as T;
  }
}

export function createRuntimeClient(
  loadedConfig: LoadedConfig,
  options: Omit<RuntimeApiClientOptions, "listenOptions"> = {},
): RuntimeClient {
  return new HttpRuntimeApiClient({
    listenOptions: resolveRuntimeApiListenOptions(
      resolveRuntimeConfig(loadedConfig),
    ),
    ...options,
  });
}

function buildRequestOptions(
  listenOptions: RuntimeApiListenOptions,
  input: {
    method: "GET" | "POST";
    pathname: string;
  },
  body: string | undefined,
): http.RequestOptions {
  const headers: Record<string, string> = {
    accept: "application/json",
  };

  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(body));
  }

  switch (listenOptions.kind) {
    case "tcp":
      return {
        method: input.method,
        host: listenOptions.host,
        port: listenOptions.port,
        path: input.pathname,
        headers,
      };
    case "socket":
      return {
        method: input.method,
        socketPath: listenOptions.socketPath,
        path: input.pathname,
        headers,
      };
    case "pipe":
      return {
        method: input.method,
        socketPath: listenOptions.pipeName,
        path: input.pathname,
        headers,
      };
  }
}
