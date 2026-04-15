import type {
  PromptProvenanceRecord,
  PromptRenderedMetadata,
  PromptProvenanceSelection,
  PromptProvenanceSource,
} from "../domain-model.js";
import type { RuntimeApiRun } from "../runtime/api/types.js";
import type { RunEventRecord } from "../runtime/types.js";

import {
  diagnoseRunFailure,
  type RunFailureDiagnosis,
} from "./failure-diagnosis.js";

export type RunDiagnosticsView = "overview" | "timeline" | "prompt" | "failure" | "full";

export type RunDiagnosticsOverview = {
  headline: string;
  terminal: boolean;
  queueDurationMs: number | null;
  launchDurationMs: number | null;
  executionDurationMs: number | null;
  lastMeaningfulEventAt: string | null;
  lastEventSeq: number | null;
};

export type RunDiagnosticsTimelineEntry = {
  seq: number;
  eventType: string;
  occurredAt: string;
  level: RunEventRecord["level"];
  source: RunEventRecord["source"];
  summary: string;
  details: Record<string, unknown> | null;
};

export type RunDiagnosticsPrompt = {
  contractId: string;
  grantedCapabilities: string[];
  status: "available" | "missing";
  selection: PromptProvenanceSelection | null;
  sources: PromptProvenanceSource[];
  rendered: PromptRenderedMetadata | null;
  note: string | null;
};

export type RunDiagnostics = {
  run: RuntimeApiRun;
  overview: RunDiagnosticsOverview;
  timeline: {
    entries: RunDiagnosticsTimelineEntry[];
    milestones: {
      enqueuedAt: string | null;
      admittedAt: string | null;
      startedAt: string | null;
      readyAt: string | null;
      completedAt: string | null;
    };
  };
  prompt: RunDiagnosticsPrompt;
  failure: RunFailureDiagnosis;
};

export type RunListEntry = {
  runId: string;
  workItemId: string;
  workItemIdentifier: string | null;
  phase: RuntimeApiRun["phase"];
  provider: RuntimeApiRun["provider"];
  status: RuntimeApiRun["status"];
  createdAt: string;
  headline: string;
};

const TERMINAL_STATUSES = new Set<RuntimeApiRun["status"]>([
  "completed",
  "failed",
  "canceled",
  "stale",
]);

export function buildRunDiagnostics(
  run: RuntimeApiRun,
  events: RunEventRecord[],
): RunDiagnostics {
  const orderedEvents = [...events].sort((left, right) => left.seq - right.seq);
  const failure = diagnoseRunFailure(run, orderedEvents);
  const overview = buildOverview(run, orderedEvents, failure);

  return {
    run,
    overview,
    timeline: {
      entries: orderedEvents.map((event) => summarizeEvent(event, run)),
      milestones: {
        enqueuedAt: run.createdAt,
        admittedAt: run.admittedAt ?? null,
        startedAt: run.startedAt ?? null,
        readyAt: run.readyAt ?? null,
        completedAt: run.completedAt ?? null,
      },
    },
    prompt: buildPromptDiagnostics(run.promptContractId, run.grantedCapabilities, run.promptProvenance),
    failure,
  };
}

export function buildRunListEntry(run: RuntimeApiRun): RunListEntry {
  return {
    runId: run.runId,
    workItemId: run.workItemId,
    workItemIdentifier: run.workItemIdentifier ?? null,
    phase: run.phase,
    provider: run.provider,
    status: run.status,
    createdAt: run.createdAt,
    headline: describeRunHeadline(run),
  };
}

function buildOverview(
  run: RuntimeApiRun,
  events: RunEventRecord[],
  failure: RunFailureDiagnosis,
): RunDiagnosticsOverview {
  const lastMeaningfulEventAt =
    events.at(-1)?.occurredAt ??
    run.completedAt ??
    run.lastHeartbeatAt ??
    run.readyAt ??
    run.startedAt ??
    run.admittedAt ??
    run.createdAt;
  const readyAt = run.readyAt ?? run.startedAt ?? null;
  const executionEndAt = run.completedAt ?? lastMeaningfulEventAt;

  return {
    headline: describeRunHeadline(run, failure),
    terminal: TERMINAL_STATUSES.has(run.status),
    queueDurationMs: differenceMs(run.createdAt, run.admittedAt ?? null),
    launchDurationMs: differenceMs(run.admittedAt ?? run.createdAt, readyAt),
    executionDurationMs: differenceMs(readyAt, executionEndAt),
    lastMeaningfulEventAt,
    lastEventSeq: run.lastEventSeq ?? null,
  };
}

function buildPromptDiagnostics(
  contractId: string,
  grantedCapabilities: string[],
  promptProvenance: PromptProvenanceRecord | null | undefined,
): RunDiagnosticsPrompt {
  if (promptProvenance == null) {
    return {
      contractId,
      grantedCapabilities,
      status: "missing",
      selection: null,
      sources: [],
      rendered: null,
      note: "Prompt provenance is unavailable for this run, which usually means it predates provenance persistence.",
    };
  }

  return {
    contractId,
    grantedCapabilities,
    status: "available",
    selection: promptProvenance.selection,
    sources: promptProvenance.sources,
    rendered: promptProvenance.rendered,
    note: null,
  };
}

function summarizeEvent(
  event: RunEventRecord,
  run: RuntimeApiRun,
): RunDiagnosticsTimelineEntry {
  return {
    seq: event.seq,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    level: event.level,
    source: event.source,
    summary: renderEventSummary(event, run),
    details:
      Object.keys(event.payload).length === 0 ? null : structuredClone(event.payload),
  };
}

function renderEventSummary(event: RunEventRecord, run: RuntimeApiRun): string {
  switch (event.eventType) {
    case "run_enqueued":
      return "Run was queued for execution.";
    case "run_admitted":
      return "Runtime admitted the run and reserved execution capacity.";
    case "session_launch_requested":
      return "Provider session launch was requested.";
    case "session_started":
      return "Provider session started and entered bootstrap.";
    case "session_ready":
      return "Provider session became ready to execute work.";
    case "waiting_human": {
      const reason = readOptionalString(event.payload, "reason");
      return reason === null
        ? "Run paused for operator input."
        : `Run paused for operator input: ${reason}`;
    }
    case "human_input_received":
      return "Human input was received and the run resumed.";
    case "runtime_issue_detected": {
      const code = readOptionalString(event.payload, "code");
      const message = readOptionalString(event.payload, "message");
      if (code !== null && message !== null) {
        return `Runtime issue detected (${code}): ${message}`;
      }
      if (message !== null) {
        return `Runtime issue detected: ${message}`;
      }
      if (code !== null) {
        return `Runtime issue detected (${code}).`;
      }
      return "Runtime issue detected.";
    }
    case "progress_update": {
      const chunk = readOptionalString(event.payload, "chunk");
      return chunk === null ? "Progress update emitted." : `Progress update: ${chunk}`;
    }
    case "interrupt_requested":
      return "Soft interrupt was requested for the live session.";
    case "cancel_requested": {
      const reason = readOptionalString(event.payload, "reason");
      return reason === null
        ? "Cancellation was requested."
        : `Cancellation requested: ${reason}`;
    }
    case "run_completed":
      return run.outcome?.summary ?? "Run completed.";
    case "run_failed":
      return run.outcome?.summary ?? run.outcome?.error?.message ?? "Run failed.";
    case "run_canceled":
      return run.outcome?.summary ?? "Run was canceled.";
    case "run_stale":
      return run.outcome?.summary ?? "Run was marked stale.";
    default: {
      const message = readOptionalString(event.payload, "message");
      if (message !== null) {
        return `${humanizeEventType(event.eventType)}: ${message}`;
      }

      return humanizeEventType(event.eventType);
    }
  }
}

function describeRunHeadline(
  run: RuntimeApiRun,
  failure?: RunFailureDiagnosis,
): string {
  if (failure !== undefined && failure.category !== "none" && failure.headline !== null) {
    return failure.headline;
  }

  if (run.status === "waiting_human") {
    return run.outcome?.requestedHumanInput ??
      run.waitingHumanReason ??
      "Run is waiting for human input.";
  }

  return (
    run.outcome?.summary ??
    run.outcome?.error?.message ??
    `${capitalize(run.status)} run.`
  );
}

function differenceMs(start: string | null | undefined, end: string | null | undefined): number | null {
  if (start == null || end == null) {
    return null;
  }

  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return null;
  }

  return Math.max(0, endMs - startMs);
}

function humanizeEventType(eventType: string): string {
  const words = eventType.split("_").map((word) => capitalize(word));
  return words.join(" ");
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function readOptionalString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
