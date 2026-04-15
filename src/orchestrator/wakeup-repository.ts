import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type {
  EnqueueWakeupInput,
  EnqueueWakeupResult,
  WakeupEventRecord,
  WakeupEventStatus,
} from "./wakeup-types.js";

type WakeupRepositoryOptions = {
  now?: () => Date;
};

type RawWakeupRow = {
  event_id: string;
  provider: string;
  delivery_id: string;
  resource_type: string;
  resource_id: string;
  issue_id: string;
  action: string;
  dedupe_key: string;
  status: WakeupEventStatus;
  attempts: number;
  first_received_at: string;
  last_received_at: string;
  available_at: string;
  claimed_at: string | null;
  processed_at: string | null;
  processor_owner: string | null;
  coalesced_count: number;
  last_error: string | null;
  payload_json: string | null;
};

export class WakeupRepository {
  private readonly now: () => Date;

  constructor(
    private readonly database: Database.Database,
    options: WakeupRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  enqueue(input: EnqueueWakeupInput): EnqueueWakeupResult {
    const receivedAt = input.receivedAt;
    const availableAt = input.availableAt ?? receivedAt;

    const transaction = this.database.transaction(
      (nextInput: EnqueueWakeupInput): EnqueueWakeupResult => {
        const existing = this.database
          .prepare(
            `
              SELECT *
              FROM wakeup_events
              WHERE dedupe_key = ?
                AND status = 'queued'
            `,
          )
          .get(nextInput.dedupeKey) as RawWakeupRow | undefined;

        if (existing !== undefined) {
          this.database
            .prepare(
              `
                UPDATE wakeup_events
                SET delivery_id = ?,
                    resource_type = ?,
                    resource_id = ?,
                    issue_id = ?,
                    action = ?,
                    last_received_at = ?,
                    available_at = ?,
                    last_error = NULL,
                    payload_json = ?,
                    coalesced_count = coalesced_count + 1
                WHERE event_id = ?
              `,
            )
            .run(
              nextInput.deliveryId,
              nextInput.resourceType,
              nextInput.resourceId,
              nextInput.issueId,
              nextInput.action,
              nextInput.receivedAt,
              nextInput.receivedAt,
              nextInput.payloadJson ?? null,
              existing.event_id,
            );

          return {
            kind: "coalesced",
            event: this.getRequired(existing.event_id),
          };
        }

        const eventId = nextInput.eventId || randomUUID();
        this.database
          .prepare(
            `
              INSERT INTO wakeup_events (
                event_id,
                provider,
                delivery_id,
                resource_type,
                resource_id,
                issue_id,
                action,
                dedupe_key,
                status,
                attempts,
                first_received_at,
                last_received_at,
                available_at,
                claimed_at,
                processed_at,
                processor_owner,
                coalesced_count,
                last_error,
                payload_json
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, NULL, NULL, NULL, 0, NULL, ?)
            `,
          )
          .run(
            eventId,
            nextInput.provider,
            nextInput.deliveryId,
            nextInput.resourceType,
            nextInput.resourceId,
            nextInput.issueId,
            nextInput.action,
            nextInput.dedupeKey,
            nextInput.receivedAt,
            nextInput.receivedAt,
            availableAt,
            nextInput.payloadJson ?? null,
          );

        return {
          kind: "inserted",
          event: this.getRequired(eventId),
        };
      },
    );

    return transaction({
      ...input,
      receivedAt,
      availableAt,
    });
  }

  claimNext(owner: string, claimedAt: string = this.now().toISOString()): WakeupEventRecord | null {
    const row = this.database
      .prepare(
        `
          WITH next_event AS (
            SELECT event_id
            FROM wakeup_events
            WHERE status = 'queued'
              AND available_at <= ?
            ORDER BY available_at ASC, last_received_at ASC, event_id ASC
            LIMIT 1
          )
          UPDATE wakeup_events
          SET status = 'processing',
              attempts = attempts + 1,
              claimed_at = ?,
              processor_owner = ?,
              last_error = NULL
          WHERE event_id = (SELECT event_id FROM next_event)
          RETURNING *
        `,
      )
      .get(claimedAt, claimedAt, owner) as RawWakeupRow | undefined;

    return row === undefined ? null : mapWakeupRow(row);
  }

  markDone(eventId: string, processedAt: string = this.now().toISOString()): WakeupEventRecord {
    this.database
      .prepare(
        `
          UPDATE wakeup_events
          SET status = 'done',
              processed_at = ?,
              last_error = NULL
          WHERE event_id = ?
        `,
      )
      .run(processedAt, eventId);

    return this.getRequired(eventId);
  }

  requeue(input: {
    eventId: string;
    availableAt: string;
    lastError: string;
  }): WakeupEventRecord {
    this.database
      .prepare(
        `
          UPDATE wakeup_events
          SET status = 'queued',
              available_at = ?,
              claimed_at = NULL,
              processed_at = NULL,
              processor_owner = NULL,
              last_error = ?
          WHERE event_id = ?
        `,
      )
      .run(input.availableAt, input.lastError, input.eventId);

    return this.getRequired(input.eventId);
  }

  markDeadLetter(
    eventId: string,
    lastError: string,
    processedAt: string = this.now().toISOString(),
  ): WakeupEventRecord {
    this.database
      .prepare(
        `
          UPDATE wakeup_events
          SET status = 'dead_letter',
              processed_at = ?,
              last_error = ?
          WHERE event_id = ?
        `,
      )
      .run(processedAt, lastError, eventId);

    return this.getRequired(eventId);
  }

  get(eventId: string): WakeupEventRecord | null {
    const row = this.database
      .prepare("SELECT * FROM wakeup_events WHERE event_id = ?")
      .get(eventId) as RawWakeupRow | undefined;

    return row === undefined ? null : mapWakeupRow(row);
  }

  list(status?: WakeupEventStatus): WakeupEventRecord[] {
    const rows = (
      status === undefined
        ? this.database
            .prepare("SELECT * FROM wakeup_events ORDER BY last_received_at ASC, event_id ASC")
            .all()
        : this.database
            .prepare(
              `
                SELECT *
                FROM wakeup_events
                WHERE status = ?
                ORDER BY last_received_at ASC, event_id ASC
              `,
            )
            .all(status)
    ) as RawWakeupRow[];

    return rows.map(mapWakeupRow);
  }

  private getRequired(eventId: string): WakeupEventRecord {
    const event = this.get(eventId);

    if (event === null) {
      throw new Error(`Wakeup event '${eventId}' does not exist.`);
    }

    return event;
  }
}

function mapWakeupRow(row: RawWakeupRow): WakeupEventRecord {
  return {
    eventId: row.event_id,
    provider: row.provider,
    deliveryId: row.delivery_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    issueId: row.issue_id,
    action: row.action,
    dedupeKey: row.dedupe_key,
    status: row.status,
    attempts: row.attempts,
    firstReceivedAt: row.first_received_at,
    lastReceivedAt: row.last_received_at,
    availableAt: row.available_at,
    claimedAt: row.claimed_at,
    processedAt: row.processed_at,
    processorOwner: row.processor_owner,
    coalescedCount: row.coalesced_count,
    lastError: row.last_error,
    payloadJson: row.payload_json,
  };
}
