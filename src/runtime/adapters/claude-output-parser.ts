import type { VerificationSummary } from "../../domain-model.js";

export type ClaudeStructuredStatus =
  | "completed"
  | "failed"
  | "waiting_human";

export type ClaudeStructuredBlock = {
  status: ClaudeStructuredStatus;
  summary?: string | null;
  details?: string | null;
  verification?: VerificationSummary | null;
  requestedHumanInput?: string | null;
  raw: string;
  dedupeKey: string;
};

const STRUCTURED_HEADERS = new Set([
  "STATUS",
  "SUMMARY",
  "DETAILS",
  "VERIFICATION",
  "REQUESTED_HUMAN_INPUT",
  "ARTIFACT",
]);

const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export class ClaudeOutputParser {
  #buffer = "";
  #lastWaitingHumanKey: string | null = null;
  latestBlock: ClaudeStructuredBlock | null = null;

  push(chunk: string): {
    latestBlock: ClaudeStructuredBlock | null;
    waitingHumanBlock: ClaudeStructuredBlock | null;
  } {
    this.#buffer = trimTranscript(`${this.#buffer}${chunk}`);
    const latestBlock = parseLatestClaudeStructuredBlock(this.#buffer);
    this.latestBlock = latestBlock;

    if (
      latestBlock?.status === "waiting_human" &&
      latestBlock.dedupeKey !== this.#lastWaitingHumanKey
    ) {
      this.#lastWaitingHumanKey = latestBlock.dedupeKey;
      return {
        latestBlock,
        waitingHumanBlock: latestBlock,
      };
    }

    return {
      latestBlock,
      waitingHumanBlock: null,
    };
  }

  clearWaitingHumanDedup(): void {
    this.#lastWaitingHumanKey = null;
  }

  get transcript(): string {
    return this.#buffer;
  }
}

export function parseLatestClaudeStructuredBlock(
  text: string,
): ClaudeStructuredBlock | null {
  const normalized = normalizeTerminalText(text);
  const matches = [...normalized.matchAll(/^STATUS:\s*(completed|failed|waiting_human)\s*$/gm)];
  const lastMatch = matches.at(-1);

  if (lastMatch === undefined || lastMatch.index === undefined) {
    return null;
  }

  const start = lastMatch.index;
  const nextStart = normalized.indexOf("\nSTATUS:", start + 1);
  const raw = normalized
    .slice(start, nextStart === -1 ? undefined : nextStart + 1)
    .trim();
  const sections = parseStructuredSections(raw);
  const status = sections.STATUS as ClaudeStructuredStatus | undefined;

  if (status === undefined) {
    return null;
  }

  const summary = asOptionalText(sections.SUMMARY);
  const details = asOptionalText(sections.DETAILS);
  const verification = parseVerificationSummary(sections.VERIFICATION);
  const requestedHumanInput = asOptionalText(sections.REQUESTED_HUMAN_INPUT);

  return {
    status,
    summary,
    details,
    verification,
    requestedHumanInput,
    raw,
    dedupeKey: JSON.stringify({
      status,
      summary,
      details,
      requestedHumanInput,
    }),
  };
}

export function normalizeTerminalText(text: string): string {
  return text
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/\r\n?/g, "\n")
    .replace(/(^|\n)\s*[>›❯?]\s+(?=[A-Z_]+:)/g, "$1");
}

function trimTranscript(text: string): string {
  const maxChars = 128_000;
  if (text.length <= maxChars) {
    return text;
  }

  return text.slice(text.length - maxChars);
}

function parseStructuredSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let currentHeader: string | null = null;
  const lines = text.split("\n");

  for (const line of lines) {
    const headerMatch = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (
      headerMatch !== null &&
      STRUCTURED_HEADERS.has(headerMatch[1])
    ) {
      currentHeader = headerMatch[1];
      sections[currentHeader] = headerMatch[2];
      continue;
    }

    if (currentHeader === null) {
      continue;
    }

    sections[currentHeader] = `${sections[currentHeader]}\n${line}`;
  }

  return sections;
}

function asOptionalText(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseVerificationSummary(
  value: string | undefined,
): VerificationSummary | null {
  const notes = asOptionalText(value);

  if (notes === null) {
    return null;
  }

  const commands = [
    ...notes.matchAll(/`([^`]+)`/g),
  ].map((match) => match[1].trim());
  const failed = /\b(fail|failed|error|errors)\b/i.test(notes);

  return {
    commands,
    passed: failed === false,
    notes,
  };
}
