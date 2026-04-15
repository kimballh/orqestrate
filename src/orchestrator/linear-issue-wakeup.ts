import type { EnqueueWakeupInput } from "./wakeup-types.js";

export type CreateLinearIssueWakeupInput = {
  deliveryId: string;
  resourceType?: string;
  resourceId: string;
  issueId: string;
  action: string;
  receivedAt: string;
  payloadJson?: string | null;
};

export function createLinearIssueWakeup(
  input: CreateLinearIssueWakeupInput,
): EnqueueWakeupInput {
  return {
    eventId: "",
    provider: "linear",
    deliveryId: input.deliveryId,
    resourceType: input.resourceType ?? "Issue",
    resourceId: input.resourceId,
    issueId: input.issueId,
    action: input.action,
    dedupeKey: buildLinearIssueDedupeKey(input.issueId),
    receivedAt: input.receivedAt,
    payloadJson: input.payloadJson ?? null,
  };
}

export function buildLinearIssueDedupeKey(issueId: string): string {
  return `linear:Issue:${issueId}`;
}
