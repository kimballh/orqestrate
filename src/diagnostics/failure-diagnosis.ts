import type { RuntimeApiRun } from "../runtime/api/types.js";
import type { RunEventRecord } from "../runtime/types.js";

export type RunFailureCategory =
  | "none"
  | "waiting_human"
  | "provider"
  | "runtime"
  | "operator"
  | "unknown";

export type RunFailureDiagnosis = {
  category: RunFailureCategory;
  headline: string | null;
  explanation: string | null;
  likelyCauses: string[];
  recommendedActions: string[];
  relatedEventTypes: string[];
};

type FailureTemplate = {
  category: Exclude<RunFailureCategory, "none" | "unknown">;
  headline: string;
  explanation: string;
  likelyCauses: string[];
  recommendedActions: string[];
};

const FAILURE_CODE_MAP: Record<string, FailureTemplate> = {
  provider_bootstrap_timeout: {
    category: "provider",
    headline: "Provider bootstrap timed out.",
    explanation:
      "The runtime started a provider session but it never became ready before the bootstrap timeout expired.",
    likelyCauses: [
      "The provider binary did not launch cleanly.",
      "Authentication or startup prerequisites were missing.",
      "The provider was slow enough that the bootstrap timeout was too short for the environment.",
    ],
    recommendedActions: [
      "Check provider binary availability and auth state before retrying.",
      "Inspect recent runtime events for bootstrap-specific details.",
      "Retry only if the failure looks transient.",
    ],
  },
  waiting_human_session_ended: {
    category: "runtime",
    headline: "The session ended while waiting for human input.",
    explanation:
      "The provider had paused for operator input, but the live session exited before the runtime received a reply.",
    likelyCauses: [
      "The provider process exited unexpectedly while blocked on operator input.",
      "The terminal session was interrupted or cleaned up before the reply was delivered.",
    ],
    recommendedActions: [
      "Inspect the recent event timeline to confirm when the session ended.",
      "Decide whether to resubmit the run or hand it off manually.",
      "Record the operator decision if it changes ticket handling.",
    ],
  },
  codex_exited_waiting_human: {
    category: "runtime",
    headline: "Codex exited while waiting for human input.",
    explanation:
      "The run was paused for operator input, but the Codex session exited before the runtime could resume it.",
    likelyCauses: [
      "The provider process terminated while waiting for a human response.",
      "The session was interrupted or cleaned up before input delivery completed.",
    ],
    recommendedActions: [
      "Inspect the recent timeline for the waiting-human event and the terminal exit.",
      "Decide between resubmission and manual handoff.",
      "Capture any operator follow-up in the ticket artifact if needed.",
    ],
  },
  database_open_failed: {
    category: "runtime",
    headline: "The runtime could not open its SQLite database.",
    explanation:
      "The daemon could not access the configured runtime database, so the run could not continue safely.",
    likelyCauses: [
      "The configured state directory did not exist or was not writable.",
      "Another process held the SQLite database in a conflicting state.",
    ],
    recommendedActions: [
      "Verify the configured state directory exists and is writable.",
      "Check whether another process is holding the database file.",
      "Restart the runtime after fixing the filesystem issue.",
    ],
  },
  migration_failed: {
    category: "runtime",
    headline: "A runtime database migration failed.",
    explanation:
      "The daemon could not finish preparing the runtime database schema needed for the run.",
    likelyCauses: [
      "The database file or its parent directory was not writable.",
      "The existing database state was incompatible with the expected schema migration.",
    ],
    recommendedActions: [
      "Verify filesystem permissions for the configured state directory.",
      "Inspect the runtime logs before retrying.",
      "Avoid manual database edits unless you are deliberately doing recovery work.",
    ],
  },
};

export function diagnoseRunFailure(
  run: RuntimeApiRun,
  events: RunEventRecord[],
): RunFailureDiagnosis {
  if (run.status === "completed" && run.outcome?.error == null) {
    return {
      category: "none",
      headline: "Run completed successfully.",
      explanation: "The runtime reached a terminal completed state without a recorded error.",
      likelyCauses: [],
      recommendedActions: [],
      relatedEventTypes: collectRelatedEventTypes(events, ["run_completed"]),
    };
  }

  if (run.status === "waiting_human") {
    const requestedInput =
      run.outcome?.requestedHumanInput ?? run.waitingHumanReason ?? null;

    return {
      category: "waiting_human",
      headline: requestedInput
        ? `Waiting for human input: ${requestedInput}`
        : "Run is waiting for human input.",
      explanation:
        "The provider is live, but runtime autonomy is paused until an operator answers or approves the next step.",
      likelyCauses: [
        requestedInput ?? "The provider explicitly requested operator input.",
      ],
      recommendedActions: [
        "Inspect the timeline to confirm the latest waiting-human reason.",
        "Send the needed human input or approval through the runtime API.",
        "If the request is no longer valid, decide whether to cancel or rerun the phase.",
      ],
      relatedEventTypes: collectRelatedEventTypes(events, [
        "waiting_human",
        "human_input_received",
      ]),
    };
  }

  if (run.status === "canceled" || hasEvent(events, "cancel_requested")) {
    return {
      category: "operator",
      headline: "Run was canceled by an operator request.",
      explanation:
        "The runtime recorded a cancellation request, so this run ended because a human or orchestrator chose to stop it rather than because the provider failed on its own.",
      likelyCauses: [
        "An operator explicitly canceled the run.",
        "The orchestrator requeued or superseded the work.",
      ],
      recommendedActions: [
        "Check the cancel-request event payload for the recorded reason.",
        "Confirm whether a replacement run was submitted.",
      ],
      relatedEventTypes: collectRelatedEventTypes(events, [
        "cancel_requested",
        "run_canceled",
      ]),
    };
  }

  const staleByStatus = run.status === "stale";
  const staleByOutcome = readBooleanDetail(
    run.outcome?.error?.details,
    "staleOnRecovery",
  );
  if (staleByStatus || staleByOutcome) {
    return {
      category: "runtime",
      headline: "Run was marked stale during runtime recovery.",
      explanation:
        "The runtime lost confidence that the live session was still owned or healthy, so it reconciled the run into a stale terminal state.",
      likelyCauses: [
        "The runtime daemon restarted without rehydrating the live PTY session.",
        "Liveness checks no longer matched a still-running session.",
      ],
      recommendedActions: [
        "Inspect the event timeline to see whether work had already advanced before retrying.",
        "Reconcile planning or artifact state before submitting a replacement run.",
      ],
      relatedEventTypes: collectRelatedEventTypes(events, ["run_stale"]),
    };
  }

  const runtimeIssue = findLastRuntimeIssue(events);
  const failureCode = run.outcome?.code ?? runtimeIssue?.code ?? null;
  if (failureCode !== null) {
    const mapped = FAILURE_CODE_MAP[failureCode];
    if (mapped !== undefined) {
      return {
        ...mapped,
        relatedEventTypes: collectRelatedEventTypes(events, [
          "runtime_issue_detected",
          terminalEventTypeForRun(run),
        ]),
      };
    }
  }

  if (runtimeIssue !== null) {
    const retryable =
      runtimeIssue.retryable === true ? " This issue was marked retryable." : "";
    return {
      category: "runtime",
      headline: runtimeIssue.message ?? "Runtime issue detected.",
      explanation:
        `The runtime recorded a structured issue event before the run reached its current state.${retryable}`.trim(),
      likelyCauses: [runtimeIssue.code ?? "A runtime issue was detected."],
      recommendedActions: [
        "Inspect the recent timeline entries around the runtime issue event.",
        "Use the issue code and message to compare against the operator runbook.",
      ],
      relatedEventTypes: collectRelatedEventTypes(events, [
        "runtime_issue_detected",
        terminalEventTypeForRun(run),
      ]),
    };
  }

  if (run.outcome?.error !== null && run.outcome?.error !== undefined) {
    const error = run.outcome.error;
    return {
      category: error.providerFamily === "runtime" ? "runtime" : "provider",
      headline: error.message,
      explanation:
        "The run recorded a terminal provider error, but no more specific operator-focused heuristic matched it yet.",
      likelyCauses: [error.code],
      recommendedActions: [
        "Inspect the runtime timeline for the last meaningful event before failure.",
        "Compare the provider error with the operator runbook and recent logs.",
      ],
      relatedEventTypes: collectRelatedEventTypes(events, [terminalEventTypeForRun(run)]),
    };
  }

  if (run.status === "failed") {
    return {
      category: "unknown",
      headline: run.outcome?.summary ?? "Run failed.",
      explanation:
        "The runtime recorded a failed terminal state, but there was not enough structured data to classify the failure more precisely.",
      likelyCauses: ["The terminal outcome did not include a mapped failure code."],
      recommendedActions: [
        "Inspect the run timeline for the last meaningful event before failure.",
        "Review runtime logs if the timeline is too ambiguous.",
      ],
      relatedEventTypes: collectRelatedEventTypes(events, ["run_failed"]),
    };
  }

  return {
    category: "unknown",
    headline: null,
    explanation: null,
    likelyCauses: [],
    recommendedActions: [],
    relatedEventTypes: collectRelatedEventTypes(events, [terminalEventTypeForRun(run)]),
  };
}

type RuntimeIssueSummary = {
  code: string | null;
  message: string | null;
  retryable: boolean;
};

function findLastRuntimeIssue(events: RunEventRecord[]): RuntimeIssueSummary | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.eventType !== "runtime_issue_detected") {
      continue;
    }

    return {
      code: readOptionalString(event.payload, "code"),
      message: readOptionalString(event.payload, "message"),
      retryable: readOptionalBoolean(event.payload, "retryable") ?? false,
    };
  }

  return null;
}

function collectRelatedEventTypes(
  events: RunEventRecord[],
  preferredTypes: Array<string | null>,
): string[] {
  const seen = new Set<string>();
  const collected: string[] = [];

  for (const eventType of preferredTypes) {
    if (eventType === null || seen.has(eventType)) {
      continue;
    }

    if (events.some((event) => event.eventType === eventType)) {
      seen.add(eventType);
      collected.push(eventType);
    }
  }

  for (const event of events) {
    if (seen.has(event.eventType)) {
      continue;
    }

    seen.add(event.eventType);
    collected.push(event.eventType);
  }

  return collected;
}

function terminalEventTypeForRun(run: RuntimeApiRun): string | null {
  switch (run.status) {
    case "completed":
      return "run_completed";
    case "failed":
      return "run_failed";
    case "canceled":
      return "run_canceled";
    case "stale":
      return "run_stale";
    default:
      return null;
  }
}

function hasEvent(events: RunEventRecord[], eventType: string): boolean {
  return events.some((event) => event.eventType === eventType);
}

function readOptionalString(
  payload: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readOptionalBoolean(
  payload: Record<string, unknown> | undefined,
  key: string,
): boolean | null {
  const value = payload?.[key];
  return typeof value === "boolean" ? value : null;
}

function readBooleanDetail(
  payload: Record<string, string | number | boolean | null> | null | undefined,
  key: string,
): boolean {
  return payload?.[key] === true;
}
