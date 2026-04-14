import type { ProviderConfig } from "../config/types.js";

import { ProviderOperationError } from "./errors.js";

export type ProviderHealthCheckResult = {
  ok: boolean;
  message?: string;
};

export abstract class ProviderBackend<TConfig extends ProviderConfig> {
  readonly family: TConfig["family"];
  readonly kind: TConfig["kind"];
  readonly name: string;

  protected constructor(readonly config: TConfig) {
    this.family = config.family;
    this.kind = config.kind;
    this.name = config.name;
  }

  abstract validateConfig(): Promise<void>;

  async healthCheck(): Promise<ProviderHealthCheckResult> {
    return { ok: true };
  }

  protected unsupportedOperation(methodName: string): never {
    throw new ProviderOperationError(
      `${this.kind} provider '${this.name}' does not implement '${methodName}' yet.`,
      {
        family: this.family,
        providerKind: this.kind,
        providerName: this.name,
        methodName,
      },
    );
  }
}
