import { constants } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import type { PlanningLocalFilesProviderConfig } from "../../config/types.js";
import {
  ORCHESTRATION_STATES,
  REVIEW_OUTCOMES,
  WORK_ITEM_STATUSES,
  WORK_PHASES,
  WORK_PHASES_OR_NONE,
  type OrchestrationState,
  type ProviderError,
  type ReviewOutcome,
  type WorkItemRecord,
  type WorkItemStatus,
  type WorkPhase,
  type WorkPhaseOrNone,
} from "../../domain-model.js";
import type {
  AppendCommentInput,
  ClaimWorkItemInput,
  ListActionableWorkItemsInput,
  MarkWorkItemRunningInput,
  RenewLeaseInput,
  TransitionWorkItemInput,
} from "../../core/planning-backend.js";
import type { ProviderHealthCheckResult } from "../../core/provider-backend.js";

const ACTIONABLE_STATUSES = [
  "design",
  "plan",
  "implement",
  "review",
] as const satisfies readonly WorkItemStatus[];

const TERMINAL_STATUSES = new Set<WorkItemStatus>(["done", "canceled"]);
const ACTIONABLE_STATUS_SET = new Set<WorkItemStatus>(ACTIONABLE_STATUSES);
const INDEX_VERSION = 1;
const LOCK_RETRY_LIMIT = 120;
const LOCK_RETRY_DELAY_MS = 25;
const STALE_LOCK_TTL_MS = 30_000;
const INDEX_FILE_NAME = "index.json";
const LOCK_METADATA_FILE_NAME = "metadata.json";
const JSON_FILE_SUFFIX = ".json";
const EMPTY_INDEX_UPDATED_AT = "1970-01-01T00:00:00.000Z";

type LocalPlanningIndexEntry = {
  id: string;
  identifier: string | null;
  title: string;
  status: WorkItemStatus;
  phase: WorkPhaseOrNone;
  priority: number | null;
  updatedAt: string;
  dependencyIds: string[];
  blockedByIds: string[];
  orchestration: {
    state: OrchestrationState;
    owner: string | null;
    runId: string | null;
    leaseUntil: string | null;
  };
};

type LocalPlanningIndex = {
  version: 1;
  updatedAt: string;
  items: LocalPlanningIndexEntry[];
};

type LocalPlanningState = {
  index: LocalPlanningIndex;
  indexById: Map<string, LocalPlanningIndexEntry>;
  recordsById: Map<string, WorkItemRecord>;
};

export class LocalFilesPlanningStore {
  constructor(private readonly config: PlanningLocalFilesProviderConfig) {}

  async validateConfig(): Promise<void> {
    this.assertRootPath();
    await this.ensureLayout();
    await this.loadValidatedState();
  }

  async healthCheck(): Promise<ProviderHealthCheckResult> {
    try {
      this.assertRootPath();
      await this.ensureLayout();
      await access(this.config.root, constants.W_OK);
      await this.readIndexFile();

      const probePath = path.join(
        this.config.root,
        `.healthcheck-${process.pid}-${Date.now()}.tmp`,
      );
      await writeFile(probePath, "ok\n", { flag: "wx" });
      await rm(probePath, { force: true });

      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listActionableWorkItems(
    input: ListActionableWorkItemsInput,
  ): Promise<WorkItemRecord[]> {
    assertNonNegativeInteger(input.limit, "limit");

    if (input.limit === 0) {
      return [];
    }

    const snapshot = await this.loadIndexSnapshot();
    const statusFilter = new Set<WorkItemStatus>(
      (input.statuses ?? ACTIONABLE_STATUSES).filter((status) =>
        ACTIONABLE_STATUS_SET.has(status),
      ),
    );
    const phaseFilter = input.phases ? new Set(input.phases) : null;
    const results: WorkItemRecord[] = [];

    for (const entry of snapshot.index.items) {
      if (results.length >= input.limit) {
        break;
      }

      if (!ACTIONABLE_STATUS_SET.has(entry.status)) {
        continue;
      }

      if (!statusFilter.has(entry.status)) {
        continue;
      }

      if (entry.phase === "none") {
        continue;
      }

      if (phaseFilter && !phaseFilter.has(entry.phase as WorkPhase)) {
        continue;
      }

      if (hasActiveLease(entry.orchestration.leaseUntil)) {
        continue;
      }

      if (this.hasOpenBlockers(entry, snapshot.indexById)) {
        continue;
      }

      results.push(await this.readIssueRecord(entry.id, entry));
    }

    return results;
  }

  async getWorkItem(id: string): Promise<WorkItemRecord | null> {
    assertSafeWorkItemId(id);

    const snapshot = await this.loadIndexSnapshot();
    const entry = snapshot.indexById.get(id);

    if (!entry) {
      if (await pathExists(this.issuePath(id))) {
        throw new Error(
          `Issue '${id}' exists under ${this.issueDirPath()} but is missing from ${INDEX_FILE_NAME}.`,
        );
      }

      return null;
    }

    return this.readIssueRecord(id, entry);
  }

  async claimWorkItem(input: ClaimWorkItemInput): Promise<WorkItemRecord> {
    assertSafeWorkItemId(input.id);
    assertNonEmptyString(input.owner, "owner");
    assertNonEmptyString(input.runId, "runId");
    assertValidFutureTimestamp(input.leaseUntil, "leaseUntil");

    return this.mutateIssue(input.id, (record, state) => {
      if (!ACTIONABLE_STATUS_SET.has(record.status)) {
        throw new Error(
          `Issue '${record.id}' is in '${record.status}' and cannot be claimed.`,
        );
      }

      if (record.phase !== input.phase) {
        throw new Error(
          `Issue '${record.id}' is in phase '${record.phase}', not '${input.phase}'.`,
        );
      }

      if (hasActiveLease(record.orchestration.leaseUntil)) {
        throw new Error(`Issue '${record.id}' already has an active lease.`);
      }

      if (this.hasOpenBlockersFromRecords(record, state.recordsById)) {
        throw new Error(`Issue '${record.id}' still has open blockers.`);
      }

      return {
        ...record,
        updatedAt: nowIso(),
        orchestration: {
          ...record.orchestration,
          state: "claimed",
          owner: input.owner,
          runId: input.runId,
          leaseUntil: input.leaseUntil,
          blockedReason: null,
          lastError: null,
          attemptCount: record.orchestration.attemptCount + 1,
        },
      };
    });
  }

  async markWorkItemRunning(
    input: MarkWorkItemRunningInput,
  ): Promise<WorkItemRecord> {
    assertSafeWorkItemId(input.id);
    assertNonEmptyString(input.owner, "owner");
    assertNonEmptyString(input.runId, "runId");
    assertValidFutureTimestamp(input.leaseUntil, "leaseUntil");

    return this.mutateIssue(input.id, (record) => {
      assertLeaseHolder(record, input.owner, input.runId);

      if (
        record.orchestration.state !== "claimed" &&
        record.orchestration.state !== "running"
      ) {
        throw new Error(
          `Issue '${record.id}' cannot enter running from '${record.orchestration.state}'.`,
        );
      }

      return {
        ...record,
        updatedAt: nowIso(),
        orchestration: {
          ...record.orchestration,
          state: "running",
          owner: input.owner,
          runId: input.runId,
          leaseUntil: input.leaseUntil,
        },
      };
    });
  }

  async renewLease(input: RenewLeaseInput): Promise<WorkItemRecord> {
    assertSafeWorkItemId(input.id);
    assertNonEmptyString(input.owner, "owner");
    assertNonEmptyString(input.runId, "runId");
    assertValidFutureTimestamp(input.leaseUntil, "leaseUntil");

    return this.mutateIssue(input.id, (record) => {
      assertLeaseHolder(record, input.owner, input.runId);

      if (
        record.orchestration.state !== "claimed" &&
        record.orchestration.state !== "running"
      ) {
        throw new Error(
          `Issue '${record.id}' cannot renew a lease while in '${record.orchestration.state}'.`,
        );
      }

      return {
        ...record,
        updatedAt: nowIso(),
        orchestration: {
          ...record.orchestration,
          owner: input.owner,
          runId: input.runId,
          leaseUntil: input.leaseUntil,
        },
      };
    });
  }

  async transitionWorkItem(
    input: TransitionWorkItemInput,
  ): Promise<WorkItemRecord> {
    assertSafeWorkItemId(input.id);
    return this.mutateIssue(input.id, (record) => {
      const resolvedPhase = deriveNextPhase(
        input.nextStatus,
        input.nextPhase,
        record.phase,
      );

      if (
        hasActiveLease(record.orchestration.leaseUntil) &&
        record.orchestration.runId !== null &&
        input.runId !== undefined &&
        input.runId !== null &&
        input.runId !== record.orchestration.runId
      ) {
        throw new Error(
          `Issue '${record.id}' is leased by run '${record.orchestration.runId}', not '${input.runId}'.`,
        );
      }

      return {
        ...record,
        status: input.nextStatus,
        phase: resolvedPhase,
        updatedAt: nowIso(),
        orchestration: {
          ...record.orchestration,
          state: input.state,
          owner: null,
          runId:
            input.runId === undefined
              ? record.orchestration.runId ?? null
              : input.runId,
          leaseUntil: null,
          reviewOutcome:
            input.reviewOutcome === undefined
              ? record.orchestration.reviewOutcome ?? null
              : input.reviewOutcome,
          blockedReason:
            input.blockedReason === undefined
              ? input.nextStatus === "blocked"
                ? record.orchestration.blockedReason ?? null
                : null
              : input.blockedReason,
          lastError:
            input.lastError === undefined
              ? input.state === "failed"
                ? record.orchestration.lastError ?? null
                : null
              : input.lastError,
        },
      };
    });
  }

  async appendComment(input: AppendCommentInput): Promise<void> {
    assertSafeWorkItemId(input.id);
    assertNonEmptyString(input.body, "body");

    await this.withIssueLock(input.id, async () => {
      const state = await this.loadValidatedState();
      const record = state.recordsById.get(input.id);

      if (!record) {
        throw new Error(`Issue '${input.id}' does not exist.`);
      }

      const timestamp = nowIso();
      const commentBlock = this.formatCommentBlock(timestamp, input.body);
      await appendFile(this.commentPath(input.id), commentBlock, "utf8");

      const nextRecord: WorkItemRecord = {
        ...record,
        updatedAt: timestamp,
      };
      const nextRecords = new Map(state.recordsById);
      nextRecords.set(nextRecord.id, nextRecord);
      await this.persistIssueAndIndex(nextRecord, nextRecords);
    });
  }

  async buildDeepLink(id: string): Promise<string | null> {
    assertSafeWorkItemId(id);
    const issuePath = this.issuePath(id);
    return (await pathExists(issuePath)) ? pathToFileURL(issuePath).toString() : null;
  }

  private async mutateIssue(
    id: string,
    mutate: (
      record: WorkItemRecord,
      state: LocalPlanningState,
    ) => WorkItemRecord | Promise<WorkItemRecord>,
  ): Promise<WorkItemRecord> {
    return this.withIssueLock(id, async () => {
      const state = await this.loadValidatedState();
      const currentRecord = state.recordsById.get(id);

      if (!currentRecord) {
        throw new Error(`Issue '${id}' does not exist.`);
      }

      const nextRecord = await mutate(structuredClone(currentRecord), state);
      validateWorkItemRecord(nextRecord, {
        expectedId: id,
        source: this.issuePath(id),
      });

      const nextRecords = new Map(state.recordsById);
      nextRecords.set(nextRecord.id, nextRecord);
      assertBlockedByReferences(nextRecords);
      await this.persistIssueAndIndex(nextRecord, nextRecords);
      return nextRecord;
    });
  }

  private async persistIssueAndIndex(
    record: WorkItemRecord,
    recordsById: Map<string, WorkItemRecord>,
  ): Promise<void> {
    await this.writeJsonAtomic(this.issuePath(record.id), record);
    await this.writeJsonAtomic(
      this.indexFilePath(),
      createIndex([...recordsById.values()]),
    );
  }

  private async loadValidatedState(): Promise<LocalPlanningState> {
    const recordsById = await this.readAllIssueRecords();
    assertBlockedByReferences(recordsById);

    const expectedIndex = createIndex([...recordsById.values()]);
    const actualIndex = await this.readIndexFile();

    if (!indexesMatch(actualIndex, expectedIndex)) {
      throw new Error(
        `${INDEX_FILE_NAME} is stale or mismatched for ${this.config.root}.`,
      );
    }

    const indexById = new Map(
      expectedIndex.items.map((item) => [item.id, item] as const),
    );

    return {
      index: expectedIndex,
      indexById,
      recordsById,
    };
  }

  private async loadIndexSnapshot(): Promise<{
    index: LocalPlanningIndex;
    indexById: Map<string, LocalPlanningIndexEntry>;
  }> {
    const index = await this.readIndexFile();
    return {
      index,
      indexById: new Map(index.items.map((item) => [item.id, item] as const)),
    };
  }

  private async readAllIssueRecords(): Promise<Map<string, WorkItemRecord>> {
    const recordsById = new Map<string, WorkItemRecord>();
    const identifiers = new Map<string, string>();
    const directoryEntries = await readdir(this.issueDirPath(), {
      withFileTypes: true,
    });

    for (const entry of directoryEntries) {
      if (!entry.isFile() || !entry.name.endsWith(JSON_FILE_SUFFIX)) {
        continue;
      }

      const issueId = entry.name.slice(0, -JSON_FILE_SUFFIX.length);
      const filePath = this.issuePath(issueId);
      const record = await this.readIssueRecordFromFile(filePath, issueId);

      if (recordsById.has(record.id)) {
        throw new Error(`Duplicate issue id '${record.id}' found in ${filePath}.`);
      }

      const identifier = record.identifier ?? null;
      if (identifier !== null) {
        const existingId = identifiers.get(identifier);

        if (existingId !== undefined) {
          throw new Error(
            `Duplicate issue identifier '${identifier}' found for '${existingId}' and '${record.id}'.`,
          );
        }

        identifiers.set(identifier, record.id);
      }

      recordsById.set(record.id, record);
    }

    return recordsById;
  }

  private async readIssueRecord(
    id: string,
    expectedEntry: LocalPlanningIndexEntry,
  ): Promise<WorkItemRecord> {
    const record = await this.readIssueRecordFromFile(this.issuePath(id), id);

    if (!indexEntriesMatch(expectedEntry, createIndexEntry(record))) {
      throw new Error(
        `Issue '${id}' is out of sync with ${INDEX_FILE_NAME}.`,
      );
    }

    return record;
  }

  private async readIssueRecordFromFile(
    filePath: string,
    expectedId: string,
  ): Promise<WorkItemRecord> {
    const raw = await this.readJsonFile(filePath);
    return validateWorkItemRecord(raw, {
      expectedId,
      source: filePath,
    });
  }

  private async readIndexFile(): Promise<LocalPlanningIndex> {
    const raw = await this.readJsonFile(this.indexFilePath());
    return validateIndex(raw, this.indexFilePath());
  }

  private async readJsonFile(filePath: string): Promise<unknown> {
    let fileContents: string;

    try {
      fileContents = await readFile(filePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new Error(`Required planning file '${filePath}' does not exist.`);
      }

      throw error;
    }

    try {
      return JSON.parse(fileContents);
    } catch (error) {
      throw new Error(
        `Invalid JSON in '${filePath}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async ensureLayout(): Promise<void> {
    await mkdir(this.config.root, { recursive: true });
    await mkdir(this.issueDirPath(), { recursive: true });
    await mkdir(this.commentDirPath(), { recursive: true });
    await mkdir(this.lockDirPath(), { recursive: true });

    if (!(await pathExists(this.indexFilePath()))) {
      const recordsById = await this.readAllIssueRecords();
      await this.writeJsonAtomic(
        this.indexFilePath(),
        createIndex([...recordsById.values()]),
      );
    }
  }

  private async withIssueLock<T>(
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lockPath = this.issueLockPath(id);
    await this.acquireIssueLock(lockPath, id);

    try {
      return await operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  private async acquireIssueLock(lockPath: string, issueId: string): Promise<void> {
    for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt += 1) {
      try {
        await mkdir(lockPath);
        try {
          await this.writeJsonAtomic(path.join(lockPath, LOCK_METADATA_FILE_NAME), {
            issueId,
            pid: process.pid,
            createdAt: nowIso(),
          });
          return;
        } catch (error) {
          await rm(lockPath, { recursive: true, force: true });
          throw error;
        }
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) {
          throw error;
        }

        if (await this.isStaleLock(lockPath)) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }

        await delay(LOCK_RETRY_DELAY_MS);
      }
    }

    throw new Error(`Timed out acquiring a mutation lock for issue '${issueId}'.`);
  }

  private async isStaleLock(lockPath: string): Promise<boolean> {
    try {
      const metadataPath = path.join(lockPath, LOCK_METADATA_FILE_NAME);

      if (await pathExists(metadataPath)) {
        const raw = await this.readJsonFile(metadataPath);

        if (isRecord(raw) && typeof raw.createdAt === "string") {
          const createdAt = Date.parse(raw.createdAt);

          if (!Number.isNaN(createdAt)) {
            return Date.now() - createdAt > STALE_LOCK_TTL_MS;
          }
        }
      }

      const lockStats = await stat(lockPath);
      return Date.now() - lockStats.mtimeMs > STALE_LOCK_TTL_MS;
    } catch {
      return false;
    }
  }

  private async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  }

  private formatCommentBlock(timestamp: string, body: string): string {
    const normalizedBody = body.trim();
    return `## ${timestamp}\n\n${normalizedBody}\n\n`;
  }

  private hasOpenBlockers(
    entry: LocalPlanningIndexEntry,
    indexById: Map<string, LocalPlanningIndexEntry>,
  ): boolean {
    for (const blockerId of entry.blockedByIds) {
      const blocker = indexById.get(blockerId);

      if (!blocker) {
        throw new Error(
          `Issue '${entry.id}' references missing blocker '${blockerId}'.`,
        );
      }

      if (!TERMINAL_STATUSES.has(blocker.status)) {
        return true;
      }
    }

    return false;
  }

  private hasOpenBlockersFromRecords(
    record: WorkItemRecord,
    recordsById: Map<string, WorkItemRecord>,
  ): boolean {
    for (const blockerId of record.blockedByIds) {
      const blocker = recordsById.get(blockerId);

      if (!blocker) {
        throw new Error(
          `Issue '${record.id}' references missing blocker '${blockerId}'.`,
        );
      }

      if (!TERMINAL_STATUSES.has(blocker.status)) {
        return true;
      }
    }

    return false;
  }

  private assertRootPath(): void {
    if (!path.isAbsolute(this.config.root)) {
      throw new Error(
        `planning.local_files root must be absolute, received '${this.config.root}'.`,
      );
    }
  }

  private issueDirPath(): string {
    return path.join(this.config.root, "issues");
  }

  private commentDirPath(): string {
    return path.join(this.config.root, "comments");
  }

  private lockDirPath(): string {
    return path.join(this.config.root, "locks");
  }

  private indexFilePath(): string {
    return path.join(this.config.root, INDEX_FILE_NAME);
  }

  private issuePath(id: string): string {
    return path.join(this.issueDirPath(), `${id}${JSON_FILE_SUFFIX}`);
  }

  private commentPath(id: string): string {
    return path.join(this.commentDirPath(), `${id}.md`);
  }

  private issueLockPath(id: string): string {
    return path.join(this.lockDirPath(), `${id}.lock`);
  }
}

function createIndex(records: WorkItemRecord[]): LocalPlanningIndex {
  const items = records.map(createIndexEntry).sort(compareIndexEntries);
  const updatedAt =
    items.reduce<string | null>((latest, item) => {
      if (latest === null) {
        return item.updatedAt;
      }

      return Date.parse(item.updatedAt) > Date.parse(latest)
        ? item.updatedAt
        : latest;
    }, null) ?? EMPTY_INDEX_UPDATED_AT;

  return {
    version: INDEX_VERSION,
    updatedAt,
    items,
  };
}

function createIndexEntry(record: WorkItemRecord): LocalPlanningIndexEntry {
  return {
    id: record.id,
    identifier: record.identifier ?? null,
    title: record.title,
    status: record.status,
    phase: record.phase,
    priority: record.priority ?? null,
    updatedAt: record.updatedAt,
    dependencyIds: [...record.dependencyIds],
    blockedByIds: [...record.blockedByIds],
    orchestration: {
      state: record.orchestration.state,
      owner: record.orchestration.owner ?? null,
      runId: record.orchestration.runId ?? null,
      leaseUntil: record.orchestration.leaseUntil ?? null,
    },
  };
}

function indexesMatch(
  left: LocalPlanningIndex,
  right: LocalPlanningIndex,
): boolean {
  if (left.version !== right.version) {
    return false;
  }

  if (left.updatedAt !== right.updatedAt) {
    return false;
  }

  if (left.items.length !== right.items.length) {
    return false;
  }

  return left.items.every((item, index) =>
    indexEntriesMatch(item, right.items[index]),
  );
}

function indexEntriesMatch(
  left: LocalPlanningIndexEntry,
  right: LocalPlanningIndexEntry,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareIndexEntries(
  left: LocalPlanningIndexEntry,
  right: LocalPlanningIndexEntry,
): number {
  const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER;
  const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER;

  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  const updatedAtComparison =
    Date.parse(left.updatedAt) - Date.parse(right.updatedAt);

  if (updatedAtComparison !== 0) {
    return updatedAtComparison;
  }

  return left.id.localeCompare(right.id);
}

function validateIndex(raw: unknown, source: string): LocalPlanningIndex {
  if (!isRecord(raw)) {
    throw new Error(`Index file '${source}' must contain an object.`);
  }

  if (raw.version !== INDEX_VERSION) {
    throw new Error(
      `Index file '${source}' must use version ${INDEX_VERSION}.`,
    );
  }

  const updatedAt = readIsoTimestamp(raw.updatedAt, "updatedAt", source);

  if (!Array.isArray(raw.items)) {
    throw new Error(`Index file '${source}' must contain an 'items' array.`);
  }

  return {
    version: INDEX_VERSION,
    updatedAt,
    items: raw.items.map((item, index) =>
      validateIndexEntry(item, `${source} item ${index}`),
    ),
  };
}

function validateIndexEntry(
  raw: unknown,
  source: string,
): LocalPlanningIndexEntry {
  if (!isRecord(raw)) {
    throw new Error(`${source} must be an object.`);
  }

  const status = readEnumValue(raw.status, WORK_ITEM_STATUSES, "status", source);
  const phase = readEnumValue(raw.phase, WORK_PHASES_OR_NONE, "phase", source);

  return {
    id: readNonEmptyString(raw.id, "id", source),
    identifier: readNullableString(raw.identifier, "identifier", source),
    title: readNonEmptyString(raw.title, "title", source),
    status,
    phase,
    priority: readNullableNumber(raw.priority, "priority", source),
    updatedAt: readIsoTimestamp(raw.updatedAt, "updatedAt", source),
    dependencyIds: readStringArray(raw.dependencyIds, "dependencyIds", source),
    blockedByIds: readStringArray(raw.blockedByIds, "blockedByIds", source),
    orchestration: validateIndexOrchestration(
      raw.orchestration,
      `${source}.orchestration`,
    ),
  };
}

function validateIndexOrchestration(
  raw: unknown,
  source: string,
): LocalPlanningIndexEntry["orchestration"] {
  if (!isRecord(raw)) {
    throw new Error(`${source} must be an object.`);
  }

  return {
    state: readEnumValue(raw.state, ORCHESTRATION_STATES, "state", source),
    owner: readNullableString(raw.owner, "owner", source),
    runId: readNullableString(raw.runId, "runId", source),
    leaseUntil: readNullableTimestamp(raw.leaseUntil, "leaseUntil", source),
  };
}

function validateWorkItemRecord(
  raw: unknown,
  options: { expectedId: string; source: string },
): WorkItemRecord {
  if (!isRecord(raw)) {
    throw new Error(`Work item '${options.source}' must contain an object.`);
  }

  const id = readNonEmptyString(raw.id, "id", options.source);

  if (id !== options.expectedId) {
    throw new Error(
      `Work item '${options.source}' must use id '${options.expectedId}', received '${id}'.`,
    );
  }

  const status = readEnumValue(
    raw.status,
    WORK_ITEM_STATUSES,
    "status",
    options.source,
  );
  const phase = readEnumValue(
    raw.phase,
    WORK_PHASES_OR_NONE,
    "phase",
    options.source,
  );
  assertStatusPhaseCombination(status, phase, options.source);

  const orchestration = validateOrchestration(
    raw.orchestration,
    `${options.source}.orchestration`,
  );

  return {
    id,
    identifier: readNullableString(raw.identifier, "identifier", options.source),
    title: readNonEmptyString(raw.title, "title", options.source),
    description: readNullableString(raw.description, "description", options.source),
    status,
    phase,
    priority: readNullableNumber(raw.priority, "priority", options.source),
    labels: readStringArray(raw.labels, "labels", options.source),
    url: readNullableString(raw.url, "url", options.source),
    parentId: readNullableString(raw.parentId, "parentId", options.source),
    dependencyIds: readStringArray(
      raw.dependencyIds,
      "dependencyIds",
      options.source,
    ),
    blockedByIds: readStringArray(
      raw.blockedByIds,
      "blockedByIds",
      options.source,
    ),
    blocksIds: readStringArray(raw.blocksIds, "blocksIds", options.source),
    artifactUrl: readNullableString(raw.artifactUrl, "artifactUrl", options.source),
    updatedAt: readIsoTimestamp(raw.updatedAt, "updatedAt", options.source),
    createdAt: readNullableTimestamp(raw.createdAt, "createdAt", options.source),
    orchestration,
  };
}

function validateOrchestration(
  raw: unknown,
  source: string,
): WorkItemRecord["orchestration"] {
  if (!isRecord(raw)) {
    throw new Error(`${source} must be an object.`);
  }

  return {
    state: readEnumValue(raw.state, ORCHESTRATION_STATES, "state", source),
    owner: readNullableString(raw.owner, "owner", source),
    runId: readNullableString(raw.runId, "runId", source),
    leaseUntil: readNullableTimestamp(raw.leaseUntil, "leaseUntil", source),
    reviewOutcome: readNullableEnumValue(
      raw.reviewOutcome,
      REVIEW_OUTCOMES,
      "reviewOutcome",
      source,
    ),
    blockedReason: readNullableString(raw.blockedReason, "blockedReason", source),
    lastError: readNullableProviderError(raw.lastError, "lastError", source),
    attemptCount: readNonNegativeInteger(raw.attemptCount, "attemptCount", source),
  };
}

function readNullableProviderError(
  value: unknown,
  fieldName: string,
  source: string,
): ProviderError | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (!isRecord(value)) {
    throw new Error(`${source}.${fieldName} must be an object or null.`);
  }

  return value as ProviderError;
}

function assertBlockedByReferences(recordsById: Map<string, WorkItemRecord>): void {
  for (const record of recordsById.values()) {
    for (const blockerId of record.blockedByIds) {
      if (!recordsById.has(blockerId)) {
        throw new Error(
          `Issue '${record.id}' references missing blocker '${blockerId}'.`,
        );
      }
    }
  }
}

function assertLeaseHolder(
  record: WorkItemRecord,
  owner: string,
  runId: string,
): void {
  if (!hasActiveLease(record.orchestration.leaseUntil)) {
    throw new Error(`Issue '${record.id}' no longer has an active lease.`);
  }

  if (record.orchestration.owner !== owner) {
    throw new Error(
      `Issue '${record.id}' is owned by '${record.orchestration.owner}', not '${owner}'.`,
    );
  }

  if (record.orchestration.runId !== runId) {
    throw new Error(
      `Issue '${record.id}' is leased to run '${record.orchestration.runId}', not '${runId}'.`,
    );
  }
}

function deriveNextPhase(
  nextStatus: WorkItemStatus,
  requestedPhase: WorkPhaseOrNone,
  currentPhase: WorkPhaseOrNone | null,
): WorkPhaseOrNone {
  if (nextStatus === "done" || nextStatus === "canceled" || nextStatus === "backlog") {
    if (requestedPhase !== "none") {
      throw new Error(`Status '${nextStatus}' must use phase 'none'.`);
    }

    return "none";
  }

  if (nextStatus === "blocked") {
    if (currentPhase === null) {
      throw new Error("Blocked transitions require the current issue phase.");
    }

    return currentPhase;
  }

  if (requestedPhase !== nextStatus) {
    throw new Error(
      `Status '${nextStatus}' must use phase '${nextStatus}', not '${requestedPhase}'.`,
    );
  }

  return requestedPhase;
}

function assertStatusPhaseCombination(
  status: WorkItemStatus,
  phase: WorkPhaseOrNone,
  source: string,
): void {
  if (
    (status === "backlog" || status === "done" || status === "canceled") &&
    phase !== "none"
  ) {
    throw new Error(
      `Work item '${source}' must use phase 'none' for status '${status}'.`,
    );
  }

  if (ACTIONABLE_STATUS_SET.has(status) && phase !== status) {
    throw new Error(
      `Work item '${source}' must use phase '${status}' for status '${status}'.`,
    );
  }
}

function hasActiveLease(leaseUntil: string | null | undefined): boolean {
  if (!leaseUntil) {
    return false;
  }

  const leaseTime = Date.parse(leaseUntil);
  return !Number.isNaN(leaseTime) && leaseTime > Date.now();
}

function nowIso(): string {
  return new Date().toISOString();
}

function assertSafeWorkItemId(id: string): void {
  assertNonEmptyString(id, "id");

  if (id.includes("/") || id.includes("\\") || id.includes("\0")) {
    throw new Error(`Invalid work item id '${id}'.`);
  }
}

function assertNonEmptyString(value: string, fieldName: string): void {
  if (value.trim() === "") {
    throw new Error(`'${fieldName}' must not be empty.`);
  }
}

function assertValidFutureTimestamp(value: string, fieldName: string): void {
  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    throw new Error(`'${fieldName}' must be a valid ISO timestamp.`);
  }

  if (timestamp <= Date.now()) {
    throw new Error(`'${fieldName}' must be in the future.`);
  }
}

function assertNonNegativeInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`'${fieldName}' must be a non-negative integer.`);
  }
}

function readNonEmptyString(
  value: unknown,
  fieldName: string,
  source: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${source}.${fieldName} must be a non-empty string.`);
  }

  return value;
}

function readNullableString(
  value: unknown,
  fieldName: string,
  source: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return readNonEmptyString(value, fieldName, source);
}

function readNullableNumber(
  value: unknown,
  fieldName: string,
  source: string,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${source}.${fieldName} must be a number or null.`);
  }

  return value;
}

function readIsoTimestamp(
  value: unknown,
  fieldName: string,
  source: string,
): string {
  const timestamp = readNonEmptyString(value, fieldName, source);

  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`${source}.${fieldName} must be a valid ISO timestamp.`);
  }

  return timestamp;
}

function readNullableTimestamp(
  value: unknown,
  fieldName: string,
  source: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return readIsoTimestamp(value, fieldName, source);
}

function readStringArray(
  value: unknown,
  fieldName: string,
  source: string,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source}.${fieldName} must be an array of strings.`);
  }

  return value.map((entry, index) =>
    readNonEmptyString(entry, `${fieldName}[${index}]`, source),
  );
}

function readNonNegativeInteger(
  value: unknown,
  fieldName: string,
  source: string,
): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(
      `${source}.${fieldName} must be a non-negative integer.`,
    );
  }

  return value as number;
}

function readEnumValue<const TValues extends readonly string[]>(
  value: unknown,
  allowedValues: TValues,
  fieldName: string,
  source: string,
): TValues[number] {
  if (typeof value !== "string" || !allowedValues.includes(value)) {
    throw new Error(
      `${source}.${fieldName} must be one of ${allowedValues.join(", ")}.`,
    );
  }

  return value as TValues[number];
}

function readNullableEnumValue<const TValues extends readonly string[]>(
  value: unknown,
  allowedValues: TValues,
  fieldName: string,
  source: string,
): TValues[number] | null {
  if (value === undefined || value === null) {
    return null;
  }

  return readEnumValue(value, allowedValues, fieldName, source);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return isRecord(error) && error.code === code;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
