import type { IncomingHttpHeaders } from "node:http";

import type { EnqueueWakeupInput } from "../../../orchestrator/wakeup-types.js";

type LinearWebhookActor = {
  id?: unknown;
  type?: unknown;
  name?: unknown;
};

type LinearWebhookPayload = {
  action?: unknown;
  type?: unknown;
  data?: unknown;
  actor?: LinearWebhookActor | null;
  createdAt?: unknown;
  webhookTimestamp?: unknown;
  webhookId?: unknown;
};

type LinearWebhookData = Record<string, unknown>;

export function normalizeLinearWebhookEvent(input: {
  headers: IncomingHttpHeaders;
  payload: LinearWebhookPayload;
  receivedAt: string;
  payloadJson: string;
}): EnqueueWakeupInput {
  const resourceType =
    readHeader(input.headers, "linear-event") ??
    readString(input.payload.type) ??
    null;

  if (resourceType === null) {
    throw new Error("Linear webhook resource type is missing.");
  }

  const action = readString(input.payload.action);
  if (action === null) {
    throw new Error("Linear webhook action is missing.");
  }

  const data = readObject(input.payload.data);
  if (data === null) {
    throw new Error("Linear webhook payload data is missing.");
  }

  const deliveryId =
    readHeader(input.headers, "linear-delivery") ??
    readString(input.payload.webhookId) ??
    null;

  if (deliveryId === null) {
    throw new Error("Linear webhook delivery id is missing.");
  }

  const resourceId = readString(data.id);
  if (resourceId === null) {
    throw new Error("Linear webhook resource id is missing.");
  }

  const issueId = extractIssueId(resourceType, data);
  if (issueId === null) {
    throw new Error(
      `Linear webhook type '${resourceType}' does not include a resolvable issue id.`,
    );
  }

  return {
    eventId: "",
    provider: "linear",
    deliveryId,
    resourceType,
    resourceId,
    issueId,
    action,
    dedupeKey: `linear:Issue:${issueId}`,
    receivedAt: input.receivedAt,
    payloadJson: input.payloadJson,
  };
}

function extractIssueId(
  resourceType: string,
  data: LinearWebhookData,
): string | null {
  if (resourceType === "Issue") {
    return readString(data.id);
  }

  return (
    readString(data.issueId) ??
    readString(readObject(data.issue)?.id) ??
    null
  );
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readHeader(
  headers: IncomingHttpHeaders,
  name: string,
): string | null {
  const value = headers[name];

  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (Array.isArray(value) && value[0] !== undefined && value[0].trim().length > 0) {
    return value[0].trim();
  }

  return null;
}
