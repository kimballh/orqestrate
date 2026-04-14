import {
  AuthenticationLinearError,
  FeatureNotAccessibleLinearError,
  ForbiddenLinearError,
  GraphqlLinearError,
  InternalLinearError,
  InvalidInputLinearError,
  LinearError,
  NetworkLinearError,
  RatelimitedLinearError,
  UnknownLinearError,
  UsageLimitExceededLinearError,
  parseLinearError,
} from "@linear/sdk";

import type { ProviderError, ProviderErrorCode } from "../../../domain-model.js";

const LINEAR_PROVIDER_FAMILY = "planning";
const LINEAR_PROVIDER_KIND = "planning.linear";

type LinearProviderErrorDetails = ProviderError["details"];

export class LinearProviderFailure extends Error {
  constructor(readonly providerError: ProviderError) {
    super(providerError.message);
    this.name = "LinearProviderFailure";
  }

  static from(error: unknown, fallbackMessage?: string): LinearProviderFailure {
    return new LinearProviderFailure(
      createLinearProviderError(error, fallbackMessage),
    );
  }
}

export function createLinearFailure(
  code: ProviderErrorCode,
  message: string,
  options: {
    retryable?: boolean;
    details?: LinearProviderErrorDetails | null;
  } = {},
): LinearProviderFailure {
  return new LinearProviderFailure({
    providerFamily: LINEAR_PROVIDER_FAMILY,
    providerKind: LINEAR_PROVIDER_KIND,
    code,
    message,
    retryable: options.retryable ?? false,
    details: options.details ?? null,
  });
}

export function createLinearProviderError(
  error: unknown,
  fallbackMessage = "Linear request failed.",
): ProviderError {
  if (error instanceof LinearProviderFailure) {
    return error.providerError;
  }

  if (isProviderError(error)) {
    return error;
  }

  const linearError = toLinearError(error);

  if (linearError === null) {
    return {
      providerFamily: LINEAR_PROVIDER_FAMILY,
      providerKind: LINEAR_PROVIDER_KIND,
      code: "unknown",
      message:
        error instanceof Error && error.message.trim() !== ""
          ? error.message
          : fallbackMessage,
      retryable: false,
      details: null,
    };
  }

  const { code, retryable } = classifyLinearError(linearError);

  return {
    providerFamily: LINEAR_PROVIDER_FAMILY,
    providerKind: LINEAR_PROVIDER_KIND,
    code,
    message: buildLinearMessage(linearError, code, fallbackMessage),
    retryable,
    details: buildLinearDetails(linearError),
  };
}

export function formatLinearProviderFailure(
  error: unknown,
  fallbackMessage = "Linear request failed.",
): string {
  return createLinearProviderError(error, fallbackMessage).message;
}

function buildLinearMessage(
  error: LinearError,
  code: ProviderErrorCode,
  fallbackMessage: string,
): string {
  const detail = firstLinearMessage(error);

  switch (code) {
    case "auth_invalid":
      return appendDetail(
        "Linear rejected the configured API token.",
        detail,
        fallbackMessage,
      );
    case "permission_denied":
      return appendDetail(
        "The configured Linear credentials do not have permission to access the requested workspace data.",
        detail,
        fallbackMessage,
      );
    case "rate_limited": {
      const retryAfterSec =
        error instanceof RatelimitedLinearError ? error.retryAfter : undefined;
      const retryAfterMessage =
        typeof retryAfterSec === "number"
          ? ` Retry after about ${retryAfterSec} seconds.`
          : "";

      return `${appendDetail("Linear rate limited the request.", detail, fallbackMessage)}${retryAfterMessage}`;
    }
    case "transport":
      return appendDetail(
        "Could not reach Linear.",
        detail,
        fallbackMessage,
      );
    case "unavailable":
      return appendDetail(
        "Linear is currently unavailable.",
        detail,
        fallbackMessage,
      );
    case "validation":
    case "not_found":
    case "conflict":
    case "unknown":
    default:
      return detail ?? fallbackMessage;
  }
}

function appendDetail(
  baseMessage: string,
  detail: string | undefined,
  fallbackMessage: string,
): string {
  if (detail === undefined || detail === "" || detail === fallbackMessage) {
    return baseMessage;
  }

  if (detail === baseMessage) {
    return baseMessage;
  }

  return `${baseMessage} ${detail}`;
}

function buildLinearDetails(error: LinearError): LinearProviderErrorDetails {
  const details: NonNullable<LinearProviderErrorDetails> = {};

  if (typeof error.status === "number") {
    details.status = error.status;
  }

  if (typeof error.type === "string") {
    details.linearErrorType = error.type;
  }

  const path = error.errors?.[0]?.path?.join(".");
  if (path !== undefined && path !== "") {
    details.graphqlPath = path;
  }

  if (error instanceof RatelimitedLinearError) {
    if (typeof error.retryAfter === "number") {
      details.retryAfterSec = error.retryAfter;
    }

    if (typeof error.requestsRemaining === "number") {
      details.requestsRemaining = error.requestsRemaining;
    }
  }

  return Object.keys(details).length === 0 ? null : details;
}

function classifyLinearError(error: LinearError): {
  code: ProviderErrorCode;
  retryable: boolean;
} {
  if (error instanceof AuthenticationLinearError || error.status === 401) {
    return { code: "auth_invalid", retryable: false };
  }

  if (
    error instanceof ForbiddenLinearError ||
    error instanceof FeatureNotAccessibleLinearError ||
    error.status === 403
  ) {
    return { code: "permission_denied", retryable: false };
  }

  if (
    error instanceof RatelimitedLinearError ||
    error instanceof UsageLimitExceededLinearError ||
    error.status === 429
  ) {
    return { code: "rate_limited", retryable: true };
  }

  if (error instanceof NetworkLinearError) {
    return { code: "transport", retryable: true };
  }

  if (
    error instanceof InvalidInputLinearError ||
    error instanceof GraphqlLinearError
  ) {
    return { code: "validation", retryable: false };
  }

  if (
    error instanceof InternalLinearError ||
    (typeof error.status === "number" && error.status >= 500)
  ) {
    return { code: "unavailable", retryable: true };
  }

  if (error instanceof UnknownLinearError) {
    return { code: "unknown", retryable: false };
  }

  return { code: "unknown", retryable: false };
}

function firstLinearMessage(error: LinearError): string | undefined {
  if (typeof error.message === "string" && error.message.trim() !== "") {
    return error.message.trim();
  }

  const graphqlMessage = error.errors
    ?.map((entry) => entry.message.trim())
    .find((entry) => entry !== "");

  return graphqlMessage === undefined || graphqlMessage === ""
    ? undefined
    : graphqlMessage;
}

function isProviderError(error: unknown): error is ProviderError {
  return (
    typeof error === "object" &&
    error !== null &&
    "providerFamily" in error &&
    "providerKind" in error &&
    "code" in error &&
    "message" in error &&
    "retryable" in error
  );
}

function toLinearError(error: unknown): LinearError | null {
  if (error instanceof LinearError) {
    return error;
  }

  try {
    return parseLinearError(error as LinearError);
  } catch {
    return null;
  }
}
