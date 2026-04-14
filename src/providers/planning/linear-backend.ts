import type { PlanningLinearProviderConfig } from "../../config/types.js";

import {
  resolveLinearPlanningConfigAdapter,
  validateLinearPlanningProviderConfig,
  type LinearPlanningConfigAdapter,
} from "./linear/config-adapter.js";
import { LinearPlanningClient } from "./linear/client.js";
import { formatLinearProviderFailure } from "./linear/errors.js";
import { UnimplementedPlanningBackend } from "./unimplemented-planning-backend.js";

type LinearPlanningBackendOptions = {
  client?: LinearPlanningClient;
};

export class LinearPlanningBackend extends UnimplementedPlanningBackend<PlanningLinearProviderConfig> {
  private client: LinearPlanningClient | null;
  private configAdapter: LinearPlanningConfigAdapter | null = null;
  private configAdapterPromise: Promise<LinearPlanningConfigAdapter> | null = null;

  constructor(
    config: PlanningLinearProviderConfig,
    options: LinearPlanningBackendOptions = {},
  ) {
    super(config);
    this.client = options.client ?? null;
  }

  async validateConfig(): Promise<void> {
    validateLinearPlanningProviderConfig(this.config);
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    try {
      const adapter = await this.getConfigAdapter();
      const scope =
        adapter.project === null
          ? `team '${adapter.team.name}'`
          : `team '${adapter.team.name}' and project '${adapter.project.name}'`;

      return {
        ok: true,
        message: `Connected to Linear ${scope}.`,
      };
    } catch (error) {
      return {
        ok: false,
        message: formatLinearProviderFailure(error),
      };
    }
  }

  async getConfigAdapter(): Promise<LinearPlanningConfigAdapter> {
    if (this.configAdapter !== null) {
      return this.configAdapter;
    }

    if (this.configAdapterPromise === null) {
      this.configAdapterPromise = resolveLinearPlanningConfigAdapter({
        client: this.getClient(),
        config: this.config,
      })
        .then((adapter) => {
          this.configAdapter = adapter;
          return adapter;
        })
        .finally(() => {
          this.configAdapterPromise = null;
        });
    }

    return this.configAdapterPromise;
  }

  private getClient(): LinearPlanningClient {
    if (this.client === null) {
      this.client = new LinearPlanningClient({
        apiKey: process.env[this.config.tokenEnv],
      });
    }

    return this.client;
  }
}
