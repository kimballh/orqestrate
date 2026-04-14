import type { ContextNotionProviderConfig } from "../../config/types.js";
import type { ProviderHealthCheckResult } from "../../core/provider-backend.js";

import {
  NotionClient,
  type NotionClientLike,
  NotionRequestError,
  normalizeNotionId,
} from "./notion-client.js";
import { UnimplementedContextBackend } from "./unimplemented-context-backend.js";

type NotionTargetRole = "artifacts" | "runs";

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

  constructor(
    config: ContextNotionProviderConfig,
    options: NotionContextBackendOptions = {},
  ) {
    super(config);
    this.env = options.env ?? process.env;
    this.client = options.client ?? null;
    this.runtimeConfig = null;
    this.targets = null;
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

      return {
        ok: true,
        message: `Authenticated to Notion as '${identity.name ?? identity.id}' and resolved both configured data sources.`,
      };
    } catch (error) {
      if (error instanceof Error) {
        this.targets = null;
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
