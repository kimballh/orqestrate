import assert from "node:assert/strict";
import test from "node:test";

import { normalizeLinearWebhookEvent } from "./webhook-normalizer.js";

test("normalizeLinearWebhookEvent resolves issue ids for issue, comment, and issue label events", () => {
  const issue = normalizeLinearWebhookEvent({
    headers: {
      "linear-delivery": "delivery-1",
      "linear-event": "Issue",
    },
    payload: {
      action: "update",
      type: "Issue",
      data: {
        id: "issue-1",
      },
    },
    receivedAt: "2026-04-15T00:00:00.000Z",
    payloadJson: "{}",
  });
  assert.equal(issue.issueId, "issue-1");
  assert.equal(issue.dedupeKey, "linear:Issue:issue-1");

  const comment = normalizeLinearWebhookEvent({
    headers: {
      "linear-delivery": "delivery-2",
      "linear-event": "Comment",
    },
    payload: {
      action: "create",
      type: "Comment",
      data: {
        id: "comment-1",
        issueId: "issue-2",
      },
    },
    receivedAt: "2026-04-15T00:00:00.000Z",
    payloadJson: "{}",
  });
  assert.equal(comment.issueId, "issue-2");
  assert.equal(comment.resourceId, "comment-1");

  const issueLabel = normalizeLinearWebhookEvent({
    headers: {
      "linear-delivery": "delivery-3",
      "linear-event": "IssueLabel",
    },
    payload: {
      action: "update",
      type: "IssueLabel",
      data: {
        id: "label-link-1",
        issue: {
          id: "issue-3",
        },
      },
    },
    receivedAt: "2026-04-15T00:00:00.000Z",
    payloadJson: "{}",
  });
  assert.equal(issueLabel.issueId, "issue-3");
  assert.equal(issueLabel.resourceType, "IssueLabel");
});
