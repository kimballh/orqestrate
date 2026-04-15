import type { RuntimeApiRun, RuntimeApiListenOptions } from "../runtime/api/types.js";
import { HttpRuntimeApiClient } from "../orchestrator/runtime-client.js";

export const ORQ_RUN_ID_ENV = "ORQ_RUN_ID";
export const ORQ_RUNTIME_API_ENDPOINT_ENV = "ORQ_RUNTIME_API_ENDPOINT";

export class GitHubRuntimeContextError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | null;

  constructor(
    message: string,
    input: {
      code: string;
      details?: Record<string, unknown> | null;
    },
  ) {
    super(message);
    this.name = "GitHubRuntimeContextError";
    this.code = input.code;
    this.details = input.details ?? null;
  }
}

export type LoadGitHubRuntimeRunDependencies = {
  getRun?: (runId: string, listenOptions: RuntimeApiListenOptions) => Promise<RuntimeApiRun>;
};

export async function loadGitHubRuntimeRun(
  env: NodeJS.ProcessEnv,
  dependencies: LoadGitHubRuntimeRunDependencies = {},
): Promise<RuntimeApiRun> {
  const runId = env[ORQ_RUN_ID_ENV]?.trim();
  if (runId === undefined || runId.length === 0) {
    throw new GitHubRuntimeContextError(
      `Missing ${ORQ_RUN_ID_ENV}; GitHub commands must run inside an Orqestrate-managed session.`,
      {
        code: "missing_run_context",
      },
    );
  }

  const endpoint = env[ORQ_RUNTIME_API_ENDPOINT_ENV]?.trim();
  if (endpoint === undefined || endpoint.length === 0) {
    throw new GitHubRuntimeContextError(
      `Missing ${ORQ_RUNTIME_API_ENDPOINT_ENV}; GitHub commands cannot load runtime scope.`,
      {
        code: "missing_runtime_endpoint",
      },
    );
  }

  const listenOptions = parseRuntimeApiEndpoint(endpoint);
  const getRun =
    dependencies.getRun ??
    (async (requestedRunId, requestedListenOptions) => {
      const client = new HttpRuntimeApiClient({
        listenOptions: requestedListenOptions,
      });
      return client.getRun(requestedRunId);
    });

  return getRun(runId, listenOptions);
}

export function parseRuntimeApiEndpoint(
  endpoint: string,
): RuntimeApiListenOptions {
  if (endpoint.startsWith("unix://")) {
    const socketPath = endpoint.slice("unix://".length);
    if (socketPath.length === 0) {
      throw new GitHubRuntimeContextError(
        `Runtime API endpoint '${endpoint}' is missing a socket path.`,
        {
          code: "invalid_runtime_endpoint",
          details: {
            endpoint,
          },
        },
      );
    }

    return {
      kind: "socket",
      socketPath,
    };
  }

  if (endpoint.startsWith("pipe://")) {
    const pipeName = endpoint.slice("pipe://".length);
    if (pipeName.length === 0) {
      throw new GitHubRuntimeContextError(
        `Runtime API endpoint '${endpoint}' is missing a pipe name.`,
        {
          code: "invalid_runtime_endpoint",
          details: {
            endpoint,
          },
        },
      );
    }

    return {
      kind: "pipe",
      pipeName,
    };
  }

  if (endpoint.startsWith("http://")) {
    const url = new URL(endpoint);
    const port = Number.parseInt(url.port, 10);
    if (Number.isInteger(port) === false || port <= 0) {
      throw new GitHubRuntimeContextError(
        `Runtime API endpoint '${endpoint}' is missing a valid port.`,
        {
          code: "invalid_runtime_endpoint",
          details: {
            endpoint,
          },
        },
      );
    }

    return {
      kind: "tcp",
      host: url.hostname,
      port,
    };
  }

  throw new GitHubRuntimeContextError(
    `Runtime API endpoint '${endpoint}' is not supported.`,
    {
      code: "invalid_runtime_endpoint",
      details: {
        endpoint,
      },
    },
  );
}
