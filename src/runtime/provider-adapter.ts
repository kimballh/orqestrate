import type {
  AgentProvider,
  PromptEnvelope,
  ProviderError,
  ProviderErrorCode,
  RunStatus,
  VerificationSummary,
} from "../domain-model.js";
import type { ExecutableRunRecord, RunEventLevel } from "./types.js";
import type {
  LaunchSpec,
  SessionExit,
  SessionOutputChunk,
  SessionSnapshot,
} from "./session-supervisor.js";

export type HumanInput = {
  kind: "answer" | "approval" | "choice" | "note";
  message: string;
  author?: string | null;
  receivedAt?: string | null;
};

export type RunLaunchInput = {
  run: ExecutableRunRecord;
  cwd: string;
  logFilePath: string;
};

export type OutputEvent = SessionOutputChunk & {
  runId: string;
};

export type RuntimeProgressSignal = {
  type: "progress";
  eventType: string;
  level?: RunEventLevel;
  payload?: Record<string, unknown>;
};

export type RuntimeWaitingHumanSignal = {
  type: "waiting_human";
  reason: string;
  payload?: Record<string, unknown>;
};

export type RuntimeIssueSignal = {
  type: "runtime_issue";
  error: ProviderError;
  payload?: Record<string, unknown>;
};

export type RuntimeSignal =
  | { type: "ready"; payload?: Record<string, unknown> }
  | RuntimeProgressSignal
  | RuntimeWaitingHumanSignal
  | RuntimeIssueSignal;

export type RunOutcome = {
  status: Extract<RunStatus, "completed" | "failed" | "canceled" | "stale">;
  code?: string | null;
  exitCode?: number | null;
  summary?: string | null;
  verification?: VerificationSummary | null;
  error?: ProviderError | null;
};

export interface RuntimeSessionController {
  readonly runId: string;
  readonly sessionId: string;
  write(input: string): Promise<void>;
  interrupt(): Promise<void>;
  terminate(force?: boolean): Promise<void>;
  snapshot(): Promise<SessionSnapshot>;
  readRecentOutput(maxChars: number): Promise<string>;
}

export interface ProviderAdapter {
  readonly kind: AgentProvider;
  buildLaunchSpec(input: RunLaunchInput): LaunchSpec;
  detectReady(snapshot: SessionSnapshot): boolean;
  classifyOutput(event: OutputEvent): RuntimeSignal[];
  submitInitialPrompt(
    session: RuntimeSessionController,
    prompt: PromptEnvelope,
  ): Promise<void>;
  submitHumanInput(
    session: RuntimeSessionController,
    input: HumanInput,
  ): Promise<void>;
  interrupt(session: RuntimeSessionController): Promise<void>;
  cancel(session: RuntimeSessionController): Promise<void>;
  collectOutcome(
    session: RuntimeSessionController,
    exit: SessionExit | null,
  ): Promise<RunOutcome>;
}

export type ProviderAdapterFactory = () => ProviderAdapter;

export function buildRuntimeProviderError(input: {
  providerKind: AgentProvider;
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, string | number | boolean | null> | null;
}): ProviderError {
  return {
    providerFamily: "runtime",
    providerKind: input.providerKind,
    code: input.code,
    message: input.message,
    retryable: input.retryable,
    details: input.details ?? null,
  };
}
