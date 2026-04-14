import {
  PROVIDER_ERROR_CODES,
  PROVIDER_FAMILIES,
  type ProviderError,
} from "../../../../domain-model.js";

export type LinearDescriptionMachineState = {
  owner: string | null;
  runId: string | null;
  leaseUntil: string | null;
  artifactUrl: string | null;
  blockedReason: string | null;
  lastError: ProviderError | null;
  attemptCount: number;
};

export type ParsedLinearDescriptionMachineState = {
  description: string | null;
  machineState: LinearDescriptionMachineState;
  hasMachineStateBlock: boolean;
};

type ManagedBlockLocation = {
  replaceStart: number;
  replaceEnd: number;
  blockStart: number;
  blockEnd: number;
  hasBoundary: boolean;
};

const MACHINE_STATE_BOUNDARY = "<!-- orqestrate:machine-state:boundary -->";
const MACHINE_STATE_START = "<!-- orqestrate:machine-state:start -->";
const MACHINE_STATE_END = "<!-- orqestrate:machine-state:end -->";
const MACHINE_STATE_WARNING =
  "Do not edit the machine-state block below manually.";

const STRING_FIELD_ALIASES = {
  owner: ["owner", "harness_owner"],
  runId: ["runId", "run_id", "harness_run_id"],
  leaseUntil: ["leaseUntil", "lease_until", "harness_lease_until"],
  artifactUrl: ["artifactUrl", "artifact_url"],
  blockedReason: ["blockedReason", "blocked_reason"],
} as const;

const LAST_ERROR_ALIASES = ["lastError", "last_error"] as const;
const ATTEMPT_COUNT_ALIASES = ["attemptCount", "attempt_count"] as const;

export const EMPTY_LINEAR_DESCRIPTION_MACHINE_STATE: LinearDescriptionMachineState =
  {
    owner: null,
    runId: null,
    leaseUntil: null,
    artifactUrl: null,
    blockedReason: null,
    lastError: null,
    attemptCount: 0,
  };

export function parseLinearDescriptionMachineState(
  description: string | null,
): ParsedLinearDescriptionMachineState {
  const source = description ?? "";
  const location = findManagedBlockLocation(source);

  if (location === null) {
    return {
      description: toNullableDescription(source),
      machineState: { ...EMPTY_LINEAR_DESCRIPTION_MACHINE_STATE },
      hasMachineStateBlock: false,
    };
  }

  const jsonSource = extractManagedJson(source, location);
  const parsed = parseManagedJson(jsonSource);
  const humanDescription = stripManagedBlock(source, location);

  return {
    description: toNullableDescription(humanDescription),
    machineState: {
      owner: readNullableStringField(parsed, STRING_FIELD_ALIASES.owner),
      runId: readNullableStringField(parsed, STRING_FIELD_ALIASES.runId),
      leaseUntil: readNullableStringField(parsed, STRING_FIELD_ALIASES.leaseUntil),
      artifactUrl: readNullableStringField(parsed, STRING_FIELD_ALIASES.artifactUrl),
      blockedReason: readNullableStringField(
        parsed,
        STRING_FIELD_ALIASES.blockedReason,
      ),
      lastError: readProviderErrorField(parsed, LAST_ERROR_ALIASES),
      attemptCount: readAttemptCountField(parsed, ATTEMPT_COUNT_ALIASES),
    },
    hasMachineStateBlock: true,
  };
}

export function upsertLinearDescriptionMachineState(
  description: string | null,
  machineState: LinearDescriptionMachineState,
): string {
  const source = description ?? "";
  const location = findManagedBlockLocation(source);
  const humanDescription =
    location === null ? source : stripManagedBlock(source, location);

  return appendManagedBlock(humanDescription, machineState);
}

function findManagedBlockLocation(
  description: string,
): ManagedBlockLocation | null {
  const boundaryMatches = [
    ...description.matchAll(toGlobalRegExp(MACHINE_STATE_BOUNDARY)),
  ];
  const startMatches = [...description.matchAll(toGlobalRegExp(MACHINE_STATE_START))];
  const endMatches = [...description.matchAll(toGlobalRegExp(MACHINE_STATE_END))];

  if (
    boundaryMatches.length === 0 &&
    startMatches.length === 0 &&
    endMatches.length === 0
  ) {
    return null;
  }

  if (
    boundaryMatches.length > 1 ||
    startMatches.length !== 1 ||
    endMatches.length !== 1
  ) {
    throw new Error(
      "Linear description contains duplicate machine-state sentinels.",
    );
  }

  const boundaryIndex = boundaryMatches[0]?.index ?? -1;
  const startIndex = startMatches[0].index ?? -1;
  const endIndex = endMatches[0].index ?? -1;

  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    throw new Error(
      "Linear description contains an incomplete machine-state block.",
    );
  }

  const hasBoundary = boundaryIndex >= 0 && boundaryIndex <= startIndex;
  const replaceStart = hasBoundary
    ? boundaryIndex
    : findManagedReplaceStart(description, startIndex);

  return {
    replaceStart,
    replaceEnd: endIndex + MACHINE_STATE_END.length,
    blockStart: startIndex,
    blockEnd: endIndex,
    hasBoundary,
  };
}

function findManagedReplaceStart(
  description: string,
  blockStart: number,
): number {
  const warningIndex = description.lastIndexOf(MACHINE_STATE_WARNING, blockStart);

  if (warningIndex < 0) {
    return blockStart;
  }

  const between = description.slice(
    warningIndex + MACHINE_STATE_WARNING.length,
    blockStart,
  );

  if (!/^\s*$/.test(between)) {
    return blockStart;
  }

  return warningIndex;
}

function extractManagedJson(
  description: string,
  location: ManagedBlockLocation,
): string {
  const blockContent = description
    .slice(location.blockStart + MACHINE_STATE_START.length, location.blockEnd)
    .trim();

  const match = blockContent.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);

  if (match === null) {
    throw new Error(
      "Linear machine-state block must contain exactly one fenced JSON payload.",
    );
  }

  return match[1];
}

function parseManagedJson(source: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Linear machine-state block contains invalid JSON.");
  }

  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw new Error(
      "Linear machine-state block must decode to a JSON object.",
    );
  }

  return parsed;
}

function stripManagedBlock(
  description: string,
  location: ManagedBlockLocation,
): string {
  return `${description.slice(0, location.replaceStart)}${description.slice(location.replaceEnd)}`;
}

function appendManagedBlock(
  description: string,
  machineState: LinearDescriptionMachineState,
): string {
  if (description === "") {
    return serializeManagedBlock(machineState, "");
  }

  const separator =
    description.endsWith("\n\n") || description.endsWith("\r\n\r\n")
      ? ""
      : description.endsWith("\n") || description.endsWith("\r\n")
        ? "\n"
        : "\n\n";

  return `${description}${serializeManagedBlock(machineState, separator)}`;
}

function serializeManagedBlock(
  machineState: LinearDescriptionMachineState,
  separator: string,
): string {
  const payload = JSON.stringify(
    {
      owner: machineState.owner,
      runId: machineState.runId,
      leaseUntil: machineState.leaseUntil,
      artifactUrl: machineState.artifactUrl,
      blockedReason: machineState.blockedReason,
      lastError: machineState.lastError,
      attemptCount: machineState.attemptCount,
    },
    null,
    2,
  );

  return (
    `${MACHINE_STATE_BOUNDARY}${separator}` +
    [
      MACHINE_STATE_WARNING,
      "",
      MACHINE_STATE_START,
      "```json",
      payload,
      "```",
      MACHINE_STATE_END,
    ].join("\n")
  );
}

function readNullableStringField(
  source: Record<string, unknown>,
  aliases: readonly string[],
): string | null {
  const value = readAliasedValue(source, aliases);

  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(
      `Linear machine-state field '${aliases[0]}' must be a string or null.`,
    );
  }

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function readProviderErrorField(
  source: Record<string, unknown>,
  aliases: readonly string[],
): ProviderError | null {
  const value = readAliasedValue(source, aliases);

  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    return trimmed === ""
      ? null
      : {
          providerFamily: "planning",
          providerKind: "planning.linear",
          code: "unknown",
          message: trimmed,
          retryable: false,
          details: null,
        };
  }

  if (!isRecord(value)) {
    throw new Error(
      `Linear machine-state field '${aliases[0]}' must be a provider error object, string, or null.`,
    );
  }

  const message = value.message;
  const providerFamily = value.providerFamily;
  const providerKind = value.providerKind;
  const code = value.code;
  const retryable = value.retryable;
  const details = value.details;

  if (
    typeof message !== "string" ||
    typeof providerFamily !== "string" ||
    typeof providerKind !== "string" ||
    typeof code !== "string" ||
    typeof retryable !== "boolean"
  ) {
    throw new Error(
      `Linear machine-state field '${aliases[0]}' must contain a complete provider error payload.`,
    );
  }

  if (!isProviderFamily(providerFamily)) {
    throw new Error(
      `Linear machine-state field '${aliases[0]}' must contain a supported provider family.`,
    );
  }

  if (!isProviderErrorCode(code)) {
    throw new Error(
      `Linear machine-state field '${aliases[0]}' must contain a supported provider error code.`,
    );
  }

  if (
    details !== undefined &&
    details !== null &&
    (!isRecord(details) || Array.isArray(details))
  ) {
    throw new Error(
      `Linear machine-state field '${aliases[0]}' must contain object details when provided.`,
    );
  }

  return {
    providerFamily,
    providerKind,
    code,
    message,
    retryable,
    details: (details as ProviderError["details"] | undefined) ?? null,
  };
}

function readAttemptCountField(
  source: Record<string, unknown>,
  aliases: readonly string[],
): number {
  const value = readAliasedValue(source, aliases);

  if (value === undefined || value === null) {
    return 0;
  }

  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(
      `Linear machine-state field '${aliases[0]}' must be a non-negative integer or null.`,
    );
  }

  return value as number;
}

function readAliasedValue(
  source: Record<string, unknown>,
  aliases: readonly string[],
): unknown {
  const present = aliases.filter((alias) => Object.hasOwn(source, alias));

  if (present.length === 0) {
    return undefined;
  }

  const [first, ...rest] = present.map((alias) => source[alias]);

  for (const value of rest) {
    if (!valuesEqual(first, value)) {
      throw new Error(
        `Linear machine-state block contains conflicting aliases for '${aliases[0]}'.`,
      );
    }
  }

  return first;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function toNullableDescription(value: string): string | null {
  return value === "" ? null : value;
}

function toGlobalRegExp(value: string): RegExp {
  return new RegExp(escapeRegExp(value), "gu");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProviderFamily(
  value: string,
): value is ProviderError["providerFamily"] {
  return PROVIDER_FAMILIES.includes(
    value as (typeof PROVIDER_FAMILIES)[number],
  );
}

function isProviderErrorCode(value: string): value is ProviderError["code"] {
  return PROVIDER_ERROR_CODES.includes(
    value as (typeof PROVIDER_ERROR_CODES)[number],
  );
}
