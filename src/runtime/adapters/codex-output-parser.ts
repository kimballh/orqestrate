import { buildRuntimeProviderError, type RuntimeSignal, type RunOutcome } from "../provider-adapter.js";
import type { SessionExit, SessionSnapshot } from "../session-supervisor.js";
import type { VerificationSummary } from "../../domain-model.js";

export type ParsedCodexStructuredBlock = {
  status: "completed" | "failed" | "waiting_human";
  summary?: string | null;
  details?: string | null;
  verification?: string | null;
  requestedHumanInput?: string | null;
};

const MAX_BUFFER_CHARS = 32_768;
const SECTION_HEADERS = new Set([
  "STATUS",
  "SUMMARY",
  "DETAILS",
  "VERIFICATION",
  "REQUESTED_HUMAN_INPUT",
]);
const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const STATUS_PATTERN =
  /(^|\n)STATUS:\s*(completed|failed|waiting_human)\s*(?=\n|$)/gi;
const PROMPT_GLYPH_PATTERN = /(?:^|[\r\n])\s*›(?:\s|$)/m;
const CODEX_SHELL_PROMPT_PATTERN = /(?:^|[\r\n])\s*>\s*(?:$|[^\r\n]+)/m;

export function normalizeCodexOutput(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "").replace(/\r/g, "");
}

export function isCodexReadySnapshot(snapshot: SessionSnapshot): boolean {
  const normalized = normalizeCodexOutput(snapshot.recentOutput);
  return (
    parseLastStructuredBlock(normalized) !== null ||
    PROMPT_GLYPH_PATTERN.test(normalized) ||
    CODEX_SHELL_PROMPT_PATTERN.test(normalized)
  );
}

export class CodexOutputParser {
  private recentOutput = "";
  private latestStructuredBlock: ParsedCodexStructuredBlock | null = null;
  private lastWaitingHumanKey: string | null = null;

  consumeChunk(chunk: string): RuntimeSignal[] {
    this.recentOutput = trimRecentOutput(
      `${this.recentOutput}${normalizeCodexOutput(chunk)}`,
      MAX_BUFFER_CHARS,
    );

    const nextBlock = parseLastStructuredBlock(this.recentOutput);
    if (nextBlock === null || isSameStructuredBlock(nextBlock, this.latestStructuredBlock)) {
      return [];
    }

    this.latestStructuredBlock = nextBlock;
    const signals: RuntimeSignal[] = [
      {
        type: "ready",
        payload: {
          source: "codex_structured_output",
          status: nextBlock.status,
        },
      },
    ];

    if (nextBlock.status === "waiting_human") {
      const reason =
        nextBlock.requestedHumanInput ??
        nextBlock.summary ??
        "Codex requested human input.";
      const nextWaitingHumanKey = JSON.stringify({
        reason,
        details: nextBlock.details ?? null,
      });

      if (nextWaitingHumanKey !== this.lastWaitingHumanKey) {
        this.lastWaitingHumanKey = nextWaitingHumanKey;
        signals.push({
          type: "waiting_human",
          reason,
          payload: {
            summary: nextBlock.summary ?? null,
            details: nextBlock.details ?? null,
          },
        });
      }
    }

    return signals;
  }

  getLatestStructuredBlock(): ParsedCodexStructuredBlock | null {
    return this.latestStructuredBlock;
  }
}

export function parseLastStructuredBlock(
  input: string,
): ParsedCodexStructuredBlock | null {
  const normalized = normalizeCodexOutput(input);
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  STATUS_PATTERN.lastIndex = 0;

  while ((match = STATUS_PATTERN.exec(normalized)) !== null) {
    lastMatch = match;
  }

  if (lastMatch === null) {
    return null;
  }

  const blockText = normalized.slice(lastMatch.index).trim();
  const sectionMap = new Map<string, string>();
  let currentSection: string | null = null;

  for (const rawLine of blockText.split("\n")) {
    const line = rawLine.trimEnd();
    const header = findSectionHeader(line);
    if (header !== null) {
      currentSection = header.name;
      sectionMap.set(header.name, header.value);
      continue;
    }

    if (currentSection === null) {
      continue;
    }

    const existingValue = sectionMap.get(currentSection);
    sectionMap.set(
      currentSection,
      [existingValue, line].filter((value) => value !== undefined).join("\n").trim(),
    );
  }

  const status = sectionMap.get("STATUS");
  if (status !== "completed" && status !== "failed" && status !== "waiting_human") {
    return null;
  }

  return {
    status,
    summary: nullIfEmpty(sectionMap.get("SUMMARY")),
    details: nullIfEmpty(sectionMap.get("DETAILS")),
    verification: nullIfEmpty(sectionMap.get("VERIFICATION")),
    requestedHumanInput: nullIfEmpty(sectionMap.get("REQUESTED_HUMAN_INPUT")),
  };
}

export function resolveCodexOutcome(input: {
  exit: SessionExit | null;
  recentOutput: string;
  latestStructuredBlock?: ParsedCodexStructuredBlock | null;
}): RunOutcome {
  const structuredBlock =
    input.latestStructuredBlock ?? parseLastStructuredBlock(input.recentOutput);

  if (structuredBlock?.status === "completed") {
    return {
      status: "completed",
      code: "completed",
      exitCode: input.exit?.exitCode ?? 0,
      summary: structuredBlock.summary ?? summarizeRecentOutput(input.recentOutput),
      verification: parseVerificationSummary(structuredBlock.verification),
    };
  }

  if (structuredBlock?.status === "failed") {
    const summary =
      structuredBlock.summary ??
      structuredBlock.details ??
      summarizeRecentOutput(input.recentOutput) ??
      "Codex reported a failure.";

    return {
      status: "failed",
      code: "codex_reported_failure",
      exitCode: input.exit?.exitCode ?? null,
      summary,
      verification: parseVerificationSummary(structuredBlock.verification),
      error: buildRuntimeProviderError({
        providerKind: "codex",
        code: "unknown",
        message: summary,
        retryable: false,
      }),
    };
  }

  if (structuredBlock?.status === "waiting_human") {
    const summary =
      structuredBlock.summary ??
      structuredBlock.requestedHumanInput ??
      "Codex exited while still waiting for human input.";

    return {
      status: "failed",
      code: "codex_exited_waiting_human",
      exitCode: input.exit?.exitCode ?? null,
      summary,
      verification: parseVerificationSummary(structuredBlock.verification),
      error: buildRuntimeProviderError({
        providerKind: "codex",
        code: "transport",
        message: summary,
        retryable: true,
      }),
    };
  }

  if ((input.exit?.exitCode ?? 0) === 0) {
    return {
      status: "completed",
      code: "completed_without_structured_status",
      exitCode: input.exit?.exitCode ?? 0,
      summary:
        summarizeRecentOutput(input.recentOutput) ??
        "Codex exited successfully without a structured status block.",
    };
  }

  if (input.exit?.exitCode === 130 || input.exit?.signal === "SIGINT") {
    return {
      status: "canceled",
      code: "canceled",
      exitCode: input.exit.exitCode,
      summary:
        summarizeRecentOutput(input.recentOutput) ??
        "Codex exited after an interrupt request.",
      error: buildRuntimeProviderError({
        providerKind: "codex",
        code: "transport",
        message: "Codex exited after an interrupt request.",
        retryable: false,
      }),
    };
  }

  const summary =
    summarizeRecentOutput(input.recentOutput) ??
    `Codex exited with code ${input.exit?.exitCode ?? "unknown"}.`;

  return {
    status: "failed",
    code: "codex_process_exit",
    exitCode: input.exit?.exitCode ?? null,
    summary,
    error: buildRuntimeProviderError({
      providerKind: "codex",
      code: "transport",
      message: summary,
      retryable: true,
      details: {
        exitCode: input.exit?.exitCode ?? null,
        signal: input.exit?.signal ?? null,
      },
    }),
  };
}

export function parseVerificationSummary(
  rawVerification: string | null | undefined,
): VerificationSummary | null {
  const verification = rawVerification?.trim();
  if (!verification) {
    return null;
  }

  const commands = verification
    .split("\n")
    .map((line) => line.trim())
    .map(stripListPrefix)
    .filter((line) => looksLikeCommand(line));
  const lowerVerification = verification.toLowerCase();

  return {
    commands,
    passed: lowerVerification.includes("fail")
      ? false
      : lowerVerification.includes("pass"),
    notes: verification,
  };
}

function findSectionHeader(
  line: string,
): { name: string; value: string } | null {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }

  const possibleHeader = line.slice(0, separatorIndex).trim();
  if (!SECTION_HEADERS.has(possibleHeader)) {
    return null;
  }

  return {
    name: possibleHeader,
    value: line.slice(separatorIndex + 1).trim(),
  };
}

function stripListPrefix(line: string): string {
  return line.replace(/^[-*]\s+/, "").trim();
}

function looksLikeCommand(line: string): boolean {
  return /^(npm|pnpm|yarn|bun|node|npx|tsx|tsc|git|bash|sh|python|pytest|uv|cargo|go|make|\.\/)/.test(
    line,
  );
}

function summarizeRecentOutput(recentOutput: string): string | null {
  const lines = normalizeCodexOutput(recentOutput)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  return lines.slice(-3).join(" ").trim();
}

function nullIfEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isSameStructuredBlock(
  left: ParsedCodexStructuredBlock | null,
  right: ParsedCodexStructuredBlock | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function trimRecentOutput(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(value.length - maxChars);
}
