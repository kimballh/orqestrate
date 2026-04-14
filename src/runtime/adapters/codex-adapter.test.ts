import assert from "node:assert/strict";
import test from "node:test";

import type { PromptEnvelope } from "../../domain-model.js";
import type { HumanInput } from "../provider-adapter.js";
import type { SessionExit, SessionSnapshot } from "../session-supervisor.js";
import { CodexProviderAdapter, renderCodexHumanInput, renderCodexInitialInput } from "./codex-adapter.js";
import {
  CodexOutputParser,
  parseLastStructuredBlock,
  parseVerificationSummary,
  resolveCodexOutcome,
} from "./codex-output-parser.js";

test("CodexProviderAdapter builds the default interactive launch spec", () => {
  const adapter = new CodexProviderAdapter();

  const launchSpec = adapter.buildLaunchSpec({
    cwd: "/repo",
    logFilePath: "/repo/.runtime/session.log",
    run: {} as never,
  });

  assert.equal(launchSpec.command, "codex");
  assert.deepEqual(launchSpec.args, [
    "--no-alt-screen",
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
  ]);
  assert.equal(launchSpec.cwd, "/repo");
});

test("renderCodexInitialInput preserves system, task, attachments, and sources", () => {
  const prompt: PromptEnvelope = {
    contractId: "orqestrate/implement/v1",
    systemPrompt: "Follow the contract.",
    userPrompt: "Implement ORQ-34.",
    attachments: [
      {
        kind: "file_path",
        label: "runtime docs",
        value: "docs/agent_runtime.md",
      },
    ],
    sources: [
      {
        kind: "role_prompt",
        ref: "docs/prompts/roles/implement.md",
      },
    ],
    digests: {
      system: "sha256-system",
      user: "sha256-user",
    },
  };

  const rendered = renderCodexInitialInput(prompt);

  assert.match(rendered, /SYSTEM INSTRUCTIONS/);
  assert.match(rendered, /Follow the contract\./);
  assert.match(rendered, /USER TASK/);
  assert.match(rendered, /Implement ORQ-34\./);
  assert.match(rendered, /\[file_path\] runtime docs: docs\/agent_runtime\.md/);
  assert.match(rendered, /\[role_prompt\] docs\/prompts\/roles\/implement\.md/);
  assert.match(rendered, /PROMPT CONTRACT ID: orqestrate\/implement\/v1/);
});

test("renderCodexHumanInput creates a labeled reply block", () => {
  const input: HumanInput = {
    kind: "approval",
    author: "Kimball Hill",
    message: "Proceed with the shared abstraction.",
  };

  const rendered = renderCodexHumanInput(input);

  assert.equal(
    rendered,
    [
      "HUMAN_INPUT_KIND: approval",
      "HUMAN_INPUT_AUTHOR: Kimball Hill",
      "HUMAN_INPUT_MESSAGE:",
      "Proceed with the shared abstraction.",
    ].join("\n"),
  );
});

test("CodexOutputParser emits ready and waiting-human once for split chunks", () => {
  const parser = new CodexOutputParser();

  assert.deepEqual(parser.consumeChunk("STATUS: waiting_h"), []);

  const signals = parser.consumeChunk(
    "uman\nSUMMARY: Need a decision.\nREQUESTED_HUMAN_INPUT: Choose the adapter path.\n",
  );
  const repeatedSignals = parser.consumeChunk(
    "STATUS: waiting_human\nSUMMARY: Need a decision.\nREQUESTED_HUMAN_INPUT: Choose the adapter path.\n",
  );

  assert.equal(signals[0]?.type, "ready");
  assert.deepEqual(signals[1], {
    type: "waiting_human",
    reason: "Choose the adapter path.",
    payload: {
      summary: "Need a decision.",
      details: null,
    },
  });
  assert.deepEqual(repeatedSignals, []);
});

test("parseLastStructuredBlock keeps multiline details and verification text", () => {
  const block = parseLastStructuredBlock(
    [
      "STATUS: completed",
      "SUMMARY: Runtime adapter implemented.",
      "DETAILS: Added default built-in registration.",
      "This line stays in the details section.",
      "VERIFICATION:",
      "- npm run test",
      "- passed",
    ].join("\n"),
  );

  assert.deepEqual(block, {
    status: "completed",
    summary: "Runtime adapter implemented.",
    details: "Added default built-in registration.\nThis line stays in the details section.",
    verification: "- npm run test\n- passed",
    requestedHumanInput: null,
  });
});

test("parseVerificationSummary extracts commands and pass/fail state", () => {
  const verification = parseVerificationSummary(
    ["- npm run check", "- passed", "- notes: smoke test not run"].join("\n"),
  );

  assert.deepEqual(verification, {
    commands: ["npm run check"],
    passed: true,
    notes: "- npm run check\n- passed\n- notes: smoke test not run",
  });
});

test("CodexProviderAdapter detects prompt and structured-output readiness", () => {
  const adapter = new CodexProviderAdapter();
  const promptSnapshot: SessionSnapshot = {
    sessionId: "session-1",
    runId: "run-1",
    pid: 1001,
    recentOutput: "Welcome to Codex\n› ",
    bytesRead: 10,
    bytesWritten: 0,
    isAlive: true,
    startedAt: "2026-04-14T18:00:00.000Z",
    lastOutputAt: null,
    lastInputAt: null,
  };
  const structuredSnapshot: SessionSnapshot = {
    ...promptSnapshot,
    recentOutput: "STATUS: completed\nSUMMARY: Done.\n",
  };

  assert.equal(adapter.detectReady(promptSnapshot), true);
  assert.equal(adapter.detectReady(structuredSnapshot), true);
});

test("resolveCodexOutcome prefers the structured completed block", () => {
  const exit: SessionExit = {
    sessionId: "session-1",
    occurredAt: "2026-04-14T18:02:00.000Z",
    exitCode: 0,
    signal: null,
  };

  const outcome = resolveCodexOutcome({
    exit,
    recentOutput: [
      "STATUS: completed",
      "SUMMARY: Implemented the runtime adapter.",
      "VERIFICATION:",
      "- npm run check",
      "- passed",
    ].join("\n"),
  });

  assert.deepEqual(outcome, {
    status: "completed",
    code: "completed",
    exitCode: 0,
    summary: "Implemented the runtime adapter.",
    verification: {
      commands: ["npm run check"],
      passed: true,
      notes: "- npm run check\n- passed",
    },
  });
});

test("resolveCodexOutcome falls back to failed transport errors on non-zero exit", () => {
  const exit: SessionExit = {
    sessionId: "session-1",
    occurredAt: "2026-04-14T18:02:00.000Z",
    exitCode: 1,
    signal: null,
  };

  const outcome = resolveCodexOutcome({
    exit,
    recentOutput: "unstructured failure output",
  });

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.code, "codex_process_exit");
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.summary ?? "", /unstructured failure output/);
  assert.equal(outcome.error?.code, "transport");
});
