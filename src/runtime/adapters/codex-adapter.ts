import type { PromptAttachment, PromptEnvelope } from "../../domain-model.js";
import {
  ORQ_RUN_ID_ENV,
  ORQ_RUNTIME_API_ENDPOINT_ENV,
} from "../../github/runtime-context.js";
import type {
  HumanInput,
  OutputEvent,
  ProviderAdapter,
  RunOutcome,
  RunLaunchInput,
  RuntimeSessionController,
  RuntimeSignal,
} from "../provider-adapter.js";
import type { SessionExit, SessionSnapshot } from "../session-supervisor.js";
import {
  CodexOutputParser,
  isCodexReadySnapshot,
  resolveCodexOutcome,
} from "./codex-output-parser.js";

export class CodexProviderAdapter implements ProviderAdapter {
  readonly kind = "codex" as const;

  private readonly outputParser = new CodexOutputParser();

  buildLaunchSpec(input: RunLaunchInput) {
    const env: Record<string, string> = {
      [ORQ_RUN_ID_ENV]: input.run.runId,
    };

    if (
      input.runtimeApiEndpoint !== undefined &&
      input.runtimeApiEndpoint !== null
    ) {
      env[ORQ_RUNTIME_API_ENDPOINT_ENV] = input.runtimeApiEndpoint;
    }

    return {
      command: "codex",
      args: [
        "--no-alt-screen",
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "never",
      ],
      env,
      cwd: input.cwd,
    };
  }

  detectReady(snapshot: SessionSnapshot): boolean {
    return isCodexReadySnapshot(snapshot);
  }

  classifyOutput(event: OutputEvent): RuntimeSignal[] {
    return this.outputParser.consumeChunk(event.chunk);
  }

  async submitInitialPrompt(
    session: RuntimeSessionController,
    prompt: PromptEnvelope,
  ): Promise<void> {
    await session.write(`${renderCodexInitialInput(prompt)}\n`);
  }

  async submitHumanInput(
    session: RuntimeSessionController,
    input: HumanInput,
  ): Promise<void> {
    this.outputParser.resetWaitingHumanState();
    await session.write(`${renderCodexHumanInput(input)}\n`);
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
    const recentOutput = await session.readRecentOutput(32_768);

    return resolveCodexOutcome({
      exit,
      recentOutput,
      latestStructuredBlock: this.outputParser.getLatestStructuredBlock(),
    });
  }
}

export function renderCodexInitialInput(prompt: PromptEnvelope): string {
  const sections = [
    "SYSTEM INSTRUCTIONS",
    prompt.systemPrompt?.trim() || "No additional system instructions.",
    "",
    "USER TASK",
    prompt.userPrompt.trim(),
  ];

  const attachments = renderPromptAttachments(prompt.attachments);
  if (attachments !== null) {
    sections.push("", "ATTACHMENTS", attachments);
  }

  if (prompt.sources.length > 0) {
    sections.push(
      "",
      "PROMPT SOURCES",
      prompt.sources.map((source) => `- [${source.kind}] ${source.ref}`).join("\n"),
    );
  }

  sections.push("", `PROMPT CONTRACT ID: ${prompt.contractId}`);
  return sections.join("\n").trim();
}

export function renderCodexHumanInput(input: HumanInput): string {
  const lines = [`HUMAN_INPUT_KIND: ${input.kind}`];

  if (input.author?.trim()) {
    lines.push(`HUMAN_INPUT_AUTHOR: ${input.author.trim()}`);
  }

  lines.push("HUMAN_INPUT_MESSAGE:");
  lines.push(input.message.trim());

  return lines.join("\n").trim();
}

function renderPromptAttachments(
  attachments: PromptAttachment[],
): string | null {
  if (attachments.length === 0) {
    return null;
  }

  return attachments
    .map((attachment) => {
      const labelPrefix = attachment.label?.trim()
        ? `${attachment.label.trim()}: `
        : "";
      return `- [${attachment.kind}] ${labelPrefix}${attachment.value}`;
    })
    .join("\n");
}
