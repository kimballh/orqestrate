import assert from "node:assert/strict";
import test from "node:test";

import {
  ClaudeOutputParser,
  parseLatestClaudeStructuredBlock,
} from "./claude-output-parser.js";

test("parseLatestClaudeStructuredBlock extracts the final structured block", () => {
  const block = parseLatestClaudeStructuredBlock(`
noise before
STATUS: failed
SUMMARY:
Old failure

DETAILS:
Previous details

STATUS: completed
SUMMARY:
Implemented the ticket.

DETAILS:
Updated the adapter and tests.

VERIFICATION:
- \`npm run check\`
- passed
`);

  assert.ok(block);
  assert.equal(block.status, "completed");
  assert.equal(block.summary, "Implemented the ticket.");
  assert.equal(block.details, "Updated the adapter and tests.");
  assert.deepEqual(block.verification, {
    commands: ["npm run check"],
    passed: true,
    notes: "- `npm run check`\n- passed",
  });
});

test("ClaudeOutputParser dedupes repeated waiting-human blocks until resumed", () => {
  const parser = new ClaudeOutputParser();
  const waitingBlock = `STATUS: waiting_human
SUMMARY:
Need a decision.

DETAILS:
Choose the migration path.

REQUESTED_HUMAN_INPUT:
Which path should I use?
`;

  const first = parser.push(waitingBlock);
  const second = parser.push(waitingBlock);

  assert.ok(first.waitingHumanBlock);
  assert.equal(second.waitingHumanBlock, null);

  parser.clearWaitingHumanDedup();

  const third = parser.push(waitingBlock);
  assert.ok(third.waitingHumanBlock);
  assert.equal(third.waitingHumanBlock?.requestedHumanInput, "Which path should I use?");
});

test("ClaudeOutputParser handles structured blocks split across PTY chunks", () => {
  const parser = new ClaudeOutputParser();

  parser.push("STATUS: waiting_human\nSUMMARY:\nNeed operator");
  const result = parser.push(" input.\n\nREQUESTED_HUMAN_INPUT:\nApprove deploy?\n");

  assert.ok(result.waitingHumanBlock);
  assert.equal(result.waitingHumanBlock?.summary, "Need operator input.");
  assert.equal(result.waitingHumanBlock?.requestedHumanInput, "Approve deploy?");
});

test("parseLatestClaudeStructuredBlock tolerates interactive prompt prefixes", () => {
  const block = parseLatestClaudeStructuredBlock(`Welcome to Claude Code
> STATUS: waiting_human
SUMMARY:
Need a decision.

REQUESTED_HUMAN_INPUT:
Approve deploy?
`);

  assert.ok(block);
  assert.equal(block.status, "waiting_human");
  assert.equal(block.requestedHumanInput, "Approve deploy?");
});
