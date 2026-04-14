import type {
  OrchestrationState,
  ProviderError,
  ReviewOutcome,
  WorkPhaseOrNone,
} from "../../../domain-model.js";

type LinearHarnessFields = {
  phase: WorkPhaseOrNone | null;
  state: OrchestrationState | null;
  owner: string | null;
  runId: string | null;
  leaseUntil: string | null;
  artifactUrl: string | null;
  reviewOutcome: ReviewOutcome | null;
  blockedReason: string | null;
  lastError: ProviderError | null;
  attemptCount: number | null;
};

const PHASE_VALUES = new Set<WorkPhaseOrNone>([
  "none",
  "design",
  "plan",
  "implement",
  "review",
  "merge",
]);

const STATE_VALUES = new Set<OrchestrationState>([
  "idle",
  "queued",
  "claimed",
  "running",
  "waiting_human",
  "failed",
  "completed",
]);

const REVIEW_OUTCOME_VALUES = new Set<ReviewOutcome>([
  "none",
  "changes_requested",
  "approved",
]);

const FIELD_ALIASES = {
  phase: ["harness_phase", "phase"],
  state: ["harness_state", "state"],
  owner: ["harness_owner", "owner"],
  runId: ["harness_run_id", "run_id"],
  leaseUntil: ["harness_lease_until", "lease_until"],
  artifactUrl: ["artifact_url", "artifacturl"],
  reviewOutcome: ["review_outcome", "reviewoutcome"],
  blockedReason: ["blocked_reason", "blockedreason"],
  lastError: ["last_error", "lasterror"],
  attemptCount: ["attempt_count", "attemptcount"],
} as const;

export function readLinearHarnessFields(source: unknown): LinearHarnessFields {
  const entries = collectFieldEntries(source);

  return {
    phase: readEnumValue(entries, FIELD_ALIASES.phase, PHASE_VALUES),
    state: readEnumValue(entries, FIELD_ALIASES.state, STATE_VALUES),
    owner: readNullableStringField(entries, FIELD_ALIASES.owner),
    runId: readNullableStringField(entries, FIELD_ALIASES.runId),
    leaseUntil: readNullableStringField(entries, FIELD_ALIASES.leaseUntil),
    artifactUrl: readNullableStringField(entries, FIELD_ALIASES.artifactUrl),
    reviewOutcome: readEnumValue(
      entries,
      FIELD_ALIASES.reviewOutcome,
      REVIEW_OUTCOME_VALUES,
    ),
    blockedReason: readNullableStringField(entries, FIELD_ALIASES.blockedReason),
    lastError: readProviderError(entries, FIELD_ALIASES.lastError),
    attemptCount: readNonNegativeInteger(entries, FIELD_ALIASES.attemptCount),
  };
}

type FieldEntry = {
  key: string;
  value: unknown;
};

function collectFieldEntries(source: unknown): FieldEntry[] {
  const entries: FieldEntry[] = [];
  collectEntriesFromRecord(source, entries);
  collectEntriesFromContainer(getRecordValue(source, "metadata"), entries);
  collectEntriesFromContainer(getRecordValue(source, "harnessFields"), entries);
  collectEntriesFromContainer(getRecordValue(source, "customFields"), entries);
  collectEntriesFromContainer(getRecordValue(source, "fieldValues"), entries);
  return entries;
}

function collectEntriesFromContainer(source: unknown, entries: FieldEntry[]): void {
  collectEntriesFromRecord(source, entries);

  if (Array.isArray(source)) {
    for (const item of source) {
      collectEntriesFromArrayItem(item, entries);
    }
    return;
  }

  const nodes = getRecordValue(source, "nodes");

  if (Array.isArray(nodes)) {
    for (const item of nodes) {
      collectEntriesFromArrayItem(item, entries);
    }
  }
}

function collectEntriesFromRecord(source: unknown, entries: FieldEntry[]): void {
  if (!isRecord(source)) {
    return;
  }

  for (const [key, value] of Object.entries(source)) {
    entries.push({
      key: normalizeKey(key),
      value,
    });
  }
}

function collectEntriesFromArrayItem(item: unknown, entries: FieldEntry[]): void {
  if (!isRecord(item)) {
    return;
  }

  const key =
    readKeyCandidate(item.name) ??
    readKeyCandidate(item.key) ??
    readKeyCandidate(getRecordValue(item, "id")) ??
    readKeyCandidate(getRecordValue(item.field, "name")) ??
    readKeyCandidate(getRecordValue(item.field, "key"));

  if (key === null) {
    return;
  }

  entries.push({
    key,
    value: readFieldValue(item),
  });
}

function readFieldValue(item: Record<string, unknown>): unknown {
  for (const key of [
    "value",
    "textValue",
    "stringValue",
    "numberValue",
    "dateValue",
    "datetimeValue",
    "booleanValue",
  ]) {
    if (key in item) {
      return item[key];
    }
  }

  const option = getRecordValue(item, "option");
  if (isRecord(option)) {
    return option.value ?? option.name ?? option.id ?? null;
  }

  return item;
}

function readEnumValue<TValue extends string>(
  entries: FieldEntry[],
  aliases: readonly string[],
  allowedValues: Set<TValue>,
): TValue | null {
  const value = readNullableString(entries, aliases);

  if (value === null) {
    return null;
  }

  return allowedValues.has(value as TValue) ? (value as TValue) : null;
}

function readNullableStringField(
  entries: FieldEntry[],
  aliases: readonly string[],
): string | null {
  return readNullableString(entries, aliases);
}

function readProviderError(
  entries: FieldEntry[],
  aliases: readonly string[],
): ProviderError | null {
  const value = readField(entries, aliases);

  if (value === undefined || value === null) {
    return null;
  }

  if (isRecord(value)) {
    const message =
      toNonEmptyString(value.message) ??
      toNonEmptyString(value.error) ??
      toNonEmptyString(value.detail);

    if (message === null) {
      return null;
    }

    return {
      providerFamily: "planning",
      providerKind: "planning.linear",
      code: "unknown",
      message,
      retryable: Boolean(value.retryable),
      details: null,
    };
  }

  const message =
    typeof value === "string" && value.trim() !== ""
      ? value.trim()
      : null;

  if (message === null) {
    return null;
  }

  return {
    providerFamily: "planning",
    providerKind: "planning.linear",
    code: "unknown",
    message,
    retryable: false,
    details: null,
  };
}

function readNonNegativeInteger(
  entries: FieldEntry[],
  aliases: readonly string[],
): number | null {
  const value = readField(entries, aliases);

  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  return null;
}

function readNullableString(
  entries: FieldEntry[],
  aliases: readonly string[],
): string | null {
  const value = readField(entries, aliases);

  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }

  return null;
}

function readField(
  entries: FieldEntry[],
  aliases: readonly string[],
): unknown {
  for (const alias of aliases) {
    const normalizedAlias = normalizeKey(alias);
    const entry = entries.find((candidate) => candidate.key === normalizedAlias);

    if (entry !== undefined) {
      return entry.value;
    }
  }

  return undefined;
}

function readKeyCandidate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = normalizeKey(value);
  return normalized === "" ? null : normalized;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function getRecordValue(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined;
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
