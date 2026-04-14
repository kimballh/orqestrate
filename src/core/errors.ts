export const PROVIDER_REGISTRATION_SOURCES = [
  "builtin",
  "extension",
] as const;

export type ProviderRegistrationSource =
  (typeof PROVIDER_REGISTRATION_SOURCES)[number];

export type ProviderBootstrapErrorCode =
  | "duplicate_provider_registration"
  | "unknown_provider_factory"
  | "provider_factory_failed"
  | "provider_validation_failed"
  | "provider_healthcheck_failed";

type ProviderBootstrapErrorOptions = {
  code: ProviderBootstrapErrorCode;
  family?: "planning" | "context";
  providerKind?: string;
  providerName?: string;
  source?: ProviderRegistrationSource;
  cause?: unknown;
};

export class ProviderBootstrapError extends Error {
  readonly code: ProviderBootstrapErrorCode;
  readonly family?: "planning" | "context";
  readonly providerKind?: string;
  readonly providerName?: string;
  readonly source?: ProviderRegistrationSource;

  constructor(message: string, options: ProviderBootstrapErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "ProviderBootstrapError";
    this.code = options.code;
    this.family = options.family;
    this.providerKind = options.providerKind;
    this.providerName = options.providerName;
    this.source = options.source;
  }
}

type ProviderOperationErrorOptions = {
  family: "planning" | "context";
  providerKind: string;
  providerName: string;
  methodName: string;
};

export class ProviderOperationError extends Error {
  readonly family: "planning" | "context";
  readonly providerKind: string;
  readonly providerName: string;
  readonly methodName: string;

  constructor(message: string, options: ProviderOperationErrorOptions) {
    super(message);
    this.name = "ProviderOperationError";
    this.family = options.family;
    this.providerKind = options.providerKind;
    this.providerName = options.providerName;
    this.methodName = options.methodName;
  }
}
