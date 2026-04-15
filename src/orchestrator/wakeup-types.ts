export const WAKEUP_EVENT_STATUSES = [
  "queued",
  "processing",
  "done",
  "dead_letter",
] as const;

export type WakeupEventStatus = (typeof WAKEUP_EVENT_STATUSES)[number];

export type WakeupEventRecord = {
  eventId: string;
  provider: string;
  deliveryId: string;
  resourceType: string;
  resourceId: string;
  issueId: string;
  action: string;
  dedupeKey: string;
  status: WakeupEventStatus;
  attempts: number;
  firstReceivedAt: string;
  lastReceivedAt: string;
  availableAt: string;
  claimedAt: string | null;
  processedAt: string | null;
  processorOwner: string | null;
  coalescedCount: number;
  lastError: string | null;
  payloadJson: string | null;
};

export type EnqueueWakeupInput = Pick<
  WakeupEventRecord,
  | "eventId"
  | "provider"
  | "deliveryId"
  | "resourceType"
  | "resourceId"
  | "issueId"
  | "action"
  | "dedupeKey"
  | "payloadJson"
> & {
  receivedAt: string;
  availableAt?: string;
};

export type EnqueueWakeupResult = {
  kind: "inserted" | "coalesced";
  event: WakeupEventRecord;
};

export type ProcessWakeupResult = {
  eventId: string;
  outcome: "noop" | "executed";
  summary: string;
};
