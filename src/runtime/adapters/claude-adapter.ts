import type { PromptEnvelope } from "../../domain-model.js";
import {
  ORQ_RUN_ID_ENV,
  ORQ_RUNTIME_API_ENDPOINT_ENV,
} from "../../github/runtime-context.js";
import {
  buildRuntimeProviderError,
  type HumanInput,
  type OutputEvent,
  type ProviderAdapter,
  type RunLaunchInput,
  type RunOutcome,
  type RuntimeSessionController,
  type RuntimeSignal,
} from "../provider-adapter.js";
import type {
  LaunchSpec,
  SessionExit,
  SessionSnapshot,
} from "../session-supervisor.js";
import {
  ClaudeOutputParser,
  normalizeTerminalText,
  parseLatestClaudeStructuredBlock,
} from "./claude-output-parser.js";

const READY_PATTERN =
  /(?:Welcome to Claude Code|Type \/help|^\s*> |\n\s*> |\n\s*\?\s)/m;
const AUTH_MISSING_PATTERNS = [
  /claude auth login/i,
  /sign in to your anthropic account/i,
  /authentication required/i,
];
const INTERRUPT_SIGNALS = new Set(["SIGINT", "2", "SIGTERM", "15", "SIGKILL", "9"]);

export class ClaudeProviderAdapter implements ProviderAdapter {
  readonly kind = "claude" as const;
  readonly #parser = new ClaudeOutputParser();
  #readySignaled = false;

  buildLaunchSpec(input: RunLaunchInput): LaunchSpec {
    const args = [
      "--bare",
      "--permission-mode",
      "bypassPermissions",
    ];
    const systemPrompt = input.run.prompt.systemPrompt?.trim();

    if (systemPrompt !== undefined && systemPrompt.length > 0) {
      args.push("--append-system-prompt", systemPrompt);
    }

    const env: Record<string, string> = {
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      [ORQ_RUN_ID_ENV]: input.run.runId,
    };

    if (
      input.runtimeApiEndpoint !== undefined &&
      input.runtimeApiEndpoint !== null
    ) {
      env[ORQ_RUNTIME_API_ENDPOINT_ENV] = input.runtimeApiEndpoint;
    }

    return {
      command: "claude",
      args,
      env,
      cwd: input.cwd,
    };
  }

  detectReady(snapshot: SessionSnapshot): boolean {
    if (!snapshot.isAlive) {
      return false;
    }

    return READY_PATTERN.test(normalizeTerminalText(snapshot.recentOutput));
  }

  classifyOutput(event: OutputEvent): RuntimeSignal[] {
    const normalizedChunk = normalizeTerminalText(event.chunk);
    const signals: RuntimeSignal[] = [];

    const authError = detectClaudeAuthError(normalizedChunk);
    if (authError !== null) {
      signals.push({
        type: "runtime_issue",
        error: authError,
      });
    }

    if (!this.#readySignaled && READY_PATTERN.test(normalizedChunk)) {
      this.#readySignaled = true;
      signals.push({
        type: "ready",
        payload: {
          source: "claude_output",
        },
      });
    }

    const { waitingHumanBlock } = this.#parser.push(event.chunk);
    if (waitingHumanBlock !== null) {
      signals.push({
        type: "waiting_human",
        reason:
          waitingHumanBlock.requestedHumanInput ??
          waitingHumanBlock.summary ??
          "Claude requested human input.",
        payload: {
          summary: waitingHumanBlock.summary ?? null,
          details: waitingHumanBlock.details ?? null,
        },
      });
    }

    return signals;
  }

  async submitInitialPrompt(
    session: RuntimeSessionController,
    prompt: PromptEnvelope,
  ): Promise<void> {
    await session.write(`${renderClaudePrompt(prompt)}\n`);
  }

  async submitHumanInput(
    session: RuntimeSessionController,
    input: HumanInput,
  ): Promise<void> {
    this.#parser.clearWaitingHumanState();
    await session.write(`${renderClaudeHumanInput(input)}\n`);
  }

  async interrupt(session: RuntimeSessionController): Promise<void> {
    await session.interrupt();
  }

  async cancel(session: RuntimeSessionController): Promise<void> {
    await session.interrupt();
  }

  async collectOutcome(
    session: RuntimeSessionController,
    exit: SessionExit | null,
  ): Promise<RunOutcome> {
    const recentOutput = await session.readRecentOutput(64_000);
    const combinedTranscript = trimCombinedTranscript(
      `${this.#parser.transcript}\n${recentOutput}`,
    );
    const parsedBlock =
      parseLatestClaudeStructuredBlock(combinedTranscript) ??
      this.#parser.latestBlock;
    const authError = detectClaudeAuthError(combinedTranscript);

    if (parsedBlock?.status === "completed") {
      return {
        status: "completed",
        code: "completed",
        exitCode: exit?.exitCode ?? null,
        summary: parsedBlock.summary ?? "Claude run completed.",
        details: parsedBlock.details ?? null,
        verification: parsedBlock.verification ?? null,
        requestedHumanInput: parsedBlock.requestedHumanInput ?? null,
        reviewOutcome: parsedBlock.reviewOutcome ?? null,
        artifactMarkdown: parsedBlock.artifactMarkdown ?? null,
      };
    }

    if (parsedBlock?.status === "failed") {
      return {
        status: "failed",
        code: "failed",
        exitCode: exit?.exitCode ?? null,
        summary: parsedBlock.summary ?? "Claude reported a failed run outcome.",
        details: parsedBlock.details ?? null,
        verification: parsedBlock.verification ?? null,
        requestedHumanInput: parsedBlock.requestedHumanInput ?? null,
        reviewOutcome: parsedBlock.reviewOutcome ?? null,
        artifactMarkdown: parsedBlock.artifactMarkdown ?? null,
      };
    }

    if (authError !== null) {
      return {
        status: "failed",
        code: "auth_missing",
        exitCode: exit?.exitCode ?? null,
        summary: "Claude CLI requires authentication before the run can continue.",
        error: authError,
      };
    }

    if (parsedBlock?.status === "waiting_human") {
      return {
        status: "failed",
        code: "waiting_human_session_ended",
        exitCode: exit?.exitCode ?? null,
        summary:
          parsedBlock.requestedHumanInput ??
          parsedBlock.summary ??
          "Claude requested human input and the session ended before resuming.",
        details: parsedBlock.details ?? null,
        verification: parsedBlock.verification ?? null,
        requestedHumanInput: parsedBlock.requestedHumanInput ?? null,
      };
    }

    if (isInterruptedExit(exit)) {
      return {
        status: "canceled",
        code: "canceled",
        exitCode: exit?.exitCode ?? null,
        summary: buildExitSummary(exit),
        error: buildRuntimeProviderError({
          providerKind: "claude",
          code: "transport",
          message: buildExitSummary(exit),
          retryable: false,
          details: {
            signal: exit?.signal ?? null,
            exitCode: exit?.exitCode ?? null,
          },
        }),
      };
    }

    if (exit?.exitCode === 0) {
      return {
        status: "completed",
        code: "completed",
        exitCode: 0,
        summary: "Claude run completed.",
      };
    }

    return {
      status: "failed",
      code: "transport_failure",
      exitCode: exit?.exitCode ?? null,
      summary: buildExitSummary(exit),
      error: buildRuntimeProviderError({
        providerKind: "claude",
        code: "transport",
        message: buildExitSummary(exit),
        retryable: false,
        details: {
          signal: exit?.signal ?? null,
          exitCode: exit?.exitCode ?? null,
        },
      }),
    };
  }
}

export function renderClaudePrompt(prompt: PromptEnvelope): string {
  const sections = [
    `CONTRACT ID:\n${prompt.contractId}`,
  ];
  const systemPrompt = prompt.systemPrompt?.trim();

  if (systemPrompt !== undefined && systemPrompt.length > 0) {
    sections.push(`SYSTEM INSTRUCTIONS:\n${systemPrompt}`);
  }

  sections.push(`USER TASK:\n${prompt.userPrompt.trim()}`);

  if (prompt.attachments.length > 0) {
    sections.push(
      `ATTACHMENTS:\n${prompt.attachments
        .map((attachment) =>
          `- [${attachment.kind}] ${attachment.label ?? attachment.value}: ${attachment.value}`)
        .join("\n")}`,
    );
  }

  if (prompt.sources.length > 0) {
    sections.push(
      `SOURCES:\n${prompt.sources
        .map((source) => `- [${source.kind}] ${source.ref}`)
        .join("\n")}`,
    );
  }

  return `${sections.join("\n\n")}\n`;
}

export function renderClaudeHumanInput(input: HumanInput): string {
  const author = input.author?.trim();
  const metadata = [
    `kind: ${input.kind}`,
  ];

  if (author !== undefined && author.length > 0) {
    metadata.push(`author: ${author}`);
  }

  return `HUMAN INPUT\n${metadata.join("\n")}\nmessage:\n${input.message.trim()}`;
}

function detectClaudeAuthError(text: string) {
  const normalized = normalizeTerminalText(text);
  if (!AUTH_MISSING_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return null;
  }

  return buildRuntimeProviderError({
    providerKind: "claude",
    code: "auth_missing",
    message: "Claude CLI requires authentication before it can run.",
    retryable: false,
  });
}

function isInterruptedExit(exit: SessionExit | null): boolean {
  if (exit === null) {
    return false;
  }

  return (
    INTERRUPT_SIGNALS.has(exit.signal ?? "") ||
    exit.exitCode === 130
  );
}

function buildExitSummary(exit: SessionExit | null): string {
  if (exit === null) {
    return "Claude session ended without an exit record.";
  }

  if (exit.signal !== null && exit.signal !== undefined) {
    return `Claude session ended with signal ${exit.signal}.`;
  }

  if (exit.exitCode !== null) {
    return `Claude session exited with code ${exit.exitCode}.`;
  }

  return "Claude session ended without an exit code.";
}

function trimCombinedTranscript(text: string): string {
  const maxChars = 128_000;
  if (text.length <= maxChars) {
    return text;
  }

  return text.slice(text.length - maxChars);
}
