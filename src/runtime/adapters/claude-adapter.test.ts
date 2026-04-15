import assert from "node:assert/strict";
import test from "node:test";

import type { PromptEnvelope } from "../../domain-model.js";
import type {
  RuntimeSessionController,
} from "../provider-adapter.js";
import type { SessionExit, SessionSnapshot } from "../session-supervisor.js";
import {
  ClaudeProviderAdapter,
  renderClaudeHumanInput,
  renderClaudePrompt,
} from "./claude-adapter.js";

test("ClaudeProviderAdapter builds a predictable launch spec", () => {
  const adapter = new ClaudeProviderAdapter();
  const launchSpec = adapter.buildLaunchSpec({
    cwd: "/repo",
    logFilePath: "/repo/.runtime/run-001/session.log",
    run: {
      runId: "run-001",
      provider: "claude",
      prompt: {
        contractId: "orqestrate/implement/v1",
        systemPrompt: "Return the required shape.",
        userPrompt: "Implement ORQ-35.",
        attachments: [],
        sources: [],
        digests: {
          system: "system-digest",
          user: "user-digest",
        },
      },
    },
  } as never);

  assert.equal(launchSpec.command, "claude");
  assert.deepEqual(launchSpec.args, [
    "--bare",
    "--permission-mode",
    "bypassPermissions",
    "--append-system-prompt",
    "Return the required shape.",
  ]);
  assert.deepEqual(launchSpec.env, {
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  });
  assert.equal(launchSpec.cwd, "/repo");
});

test("renderClaudePrompt includes contract, task, attachments, and sources", () => {
  const prompt: PromptEnvelope = {
    contractId: "orqestrate/implement/v1",
    systemPrompt: "Follow the runtime contract.",
    userPrompt: "Implement ORQ-35.",
    attachments: [
      {
        kind: "artifact_url",
        label: "Notion artifact",
        value: "https://www.notion.so/example",
      },
    ],
    sources: [
      {
        kind: "artifact",
        ref: "notion://orq-35",
      },
    ],
    digests: {
      system: "system-digest",
      user: "user-digest",
    },
  };

  const rendered = renderClaudePrompt(prompt);

  assert.match(rendered, /CONTRACT ID:\norqestrate\/implement\/v1/);
  assert.match(rendered, /SYSTEM INSTRUCTIONS:\nFollow the runtime contract\./);
  assert.match(rendered, /USER TASK:\nImplement ORQ-35\./);
  assert.match(rendered, /ATTACHMENTS:\n- \[artifact_url\] Notion artifact: https:\/\/www\.notion\.so\/example/);
  assert.match(rendered, /SOURCES:\n- \[artifact\] notion:\/\/orq-35/);
});

test("renderClaudeHumanInput emits a durable operator reply block", () => {
  assert.equal(
    renderClaudeHumanInput({
      kind: "answer",
      message: "Proceed with the migration.",
      author: "Kimball Hill",
    }),
    "HUMAN INPUT\nkind: answer\nauthor: Kimball Hill\nmessage:\nProceed with the migration.",
  );
});

test("ClaudeProviderAdapter classifies waiting-human output once until human input is submitted", async () => {
  const adapter = new ClaudeProviderAdapter();
  const waitingChunk = `STATUS: waiting_human
SUMMARY:
Need a policy decision.

REQUESTED_HUMAN_INPUT:
Should I continue?
`;

  const firstSignals = adapter.classifyOutput({
    runId: "run-001",
    sessionId: "session-1",
    occurredAt: "2026-04-14T18:00:00.000Z",
    chunk: waitingChunk,
  });
  const secondSignals = adapter.classifyOutput({
    runId: "run-001",
    sessionId: "session-1",
    occurredAt: "2026-04-14T18:00:01.000Z",
    chunk: waitingChunk,
  });

  assert.equal(firstSignals.filter((signal) => signal.type === "waiting_human").length, 1);
  assert.equal(secondSignals.filter((signal) => signal.type === "waiting_human").length, 0);

  await adapter.submitHumanInput(createController(), {
    kind: "answer",
    message: "Yes, continue.",
  });

  const thirdSignals = adapter.classifyOutput({
    runId: "run-001",
    sessionId: "session-1",
    occurredAt: "2026-04-14T18:00:02.000Z",
    chunk: waitingChunk,
  });

  assert.equal(thirdSignals.filter((signal) => signal.type === "waiting_human").length, 1);
});

test("ClaudeProviderAdapter normalizes completed and interrupted exits", async () => {
  const completedAdapter = new ClaudeProviderAdapter();
  completedAdapter.classifyOutput({
    runId: "run-001",
    sessionId: "session-1",
    occurredAt: "2026-04-14T18:00:00.000Z",
    chunk: `STATUS: completed
SUMMARY:
Finished the work.

VERIFICATION:
- \`npm run check\`
- passed
`,
  });

  const completedOutcome = await completedAdapter.collectOutcome(
    createController(),
    {
      sessionId: "session-1",
      occurredAt: "2026-04-14T18:00:01.000Z",
      exitCode: 0,
      signal: null,
    },
  );
  assert.equal(completedOutcome.status, "completed");
  assert.equal(completedOutcome.summary, "Finished the work.");
  assert.deepEqual(completedOutcome.verification, {
    commands: ["npm run check"],
    passed: true,
    notes: "- `npm run check`\n- passed",
  });

  const canceledAdapter = new ClaudeProviderAdapter();
  const canceledOutcome = await canceledAdapter.collectOutcome(
    createController(),
    {
      sessionId: "session-2",
      occurredAt: "2026-04-14T18:00:02.000Z",
      exitCode: null,
      signal: "2",
    },
  );
  assert.equal(canceledOutcome.status, "canceled");
  assert.equal(canceledOutcome.code, "canceled");
});

test("ClaudeProviderAdapter drops stale waiting-human state after resume before a clean exit", async () => {
  const adapter = new ClaudeProviderAdapter();
  adapter.classifyOutput({
    runId: "run-001",
    sessionId: "session-1",
    occurredAt: "2026-04-14T18:00:00.000Z",
    chunk: `STATUS: waiting_human
SUMMARY:
Need a decision.

REQUESTED_HUMAN_INPUT:
Should I continue?
`,
  });

  await adapter.submitHumanInput(createController(), {
    kind: "answer",
    message: "Yes, continue.",
  });

  const outcome = await adapter.collectOutcome(
    createController(""),
    {
      sessionId: "session-1",
      occurredAt: "2026-04-14T18:00:01.000Z",
      exitCode: 0,
      signal: null,
    },
  );

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.code, "completed");
});

test("ClaudeProviderAdapter reports auth prompts as runtime issues", () => {
  const adapter = new ClaudeProviderAdapter();
  const signals = adapter.classifyOutput({
    runId: "run-001",
    sessionId: "session-1",
    occurredAt: "2026-04-14T18:00:00.000Z",
    chunk: "Please run claude auth login before continuing.\n",
  });

  assert.equal(signals.filter((signal) => signal.type === "runtime_issue").length, 1);
});

test("ClaudeProviderAdapter readiness uses Claude interactive markers", () => {
  const adapter = new ClaudeProviderAdapter();
  const snapshot: SessionSnapshot = {
    sessionId: "session-1",
    runId: "run-001",
    pid: 4242,
    recentOutput: "Welcome to Claude Code\n> ",
    bytesRead: 32,
    bytesWritten: 0,
    isAlive: true,
    startedAt: "2026-04-14T18:00:00.000Z",
    lastOutputAt: "2026-04-14T18:00:01.000Z",
    lastInputAt: null,
  };

  assert.equal(adapter.detectReady(snapshot), true);
});

function createController(
  transcript = "",
  exit: SessionExit | null = null,
): RuntimeSessionController {
  return {
    runId: "run-001",
    sessionId: "session-1",
    async write(): Promise<void> {},
    async interrupt(): Promise<void> {},
    async terminate(): Promise<void> {},
    async snapshot(): Promise<SessionSnapshot> {
      throw new Error("snapshot should not be called in this test");
    },
    async readRecentOutput(): Promise<string> {
      return transcript;
    },
  };
}
