export type ConfigErrorCode =
  | "config_not_found"
  | "config_read_error"
  | "config_parse_error"
  | "unsupported_version"
  | "missing_field"
  | "invalid_type"
  | "invalid_value"
  | "unknown_key"
  | "unsupported_provider_kind"
  | "unknown_provider_reference"
  | "provider_role_mismatch"
  | "missing_active_profile"
  | "missing_env_var";

type ConfigErrorOptions = {
  code: ConfigErrorCode;
  path?: string;
  hint?: string;
  cause?: unknown;
};

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly path?: string;
  readonly hint?: string;

  constructor(message: string, options: ConfigErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "ConfigError";
    this.code = options.code;
    this.path = options.path;
    this.hint = options.hint;
  }
}

export function isConfigError(error: unknown): error is ConfigError {
  return error instanceof ConfigError;
}
