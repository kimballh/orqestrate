import type { PersistedRunRecord, RunEventRecord } from "../types.js";
import type {
  ActionRunResponse,
  CreateRunResponse,
  EventsResponse,
  GetRunResponse,
  ListRunsResponse,
  RuntimeApiRun,
} from "./types.js";

export function serializeRun(
  run: PersistedRunRecord,
  lastEventSeq: number | null,
): RuntimeApiRun {
  return {
    ...run,
    lastEventSeq,
  };
}

export function serializeCreateRunResponse(input: {
  created: boolean;
  run: PersistedRunRecord;
  lastEventSeq: number | null;
}): CreateRunResponse {
  return {
    created: input.created,
    run: serializeRun(input.run, input.lastEventSeq),
  };
}

export function serializeGetRunResponse(input: {
  run: PersistedRunRecord;
  lastEventSeq: number | null;
}): GetRunResponse {
  return {
    run: serializeRun(input.run, input.lastEventSeq),
  };
}

export function serializeListRunsResponse(input: {
  runs: Array<{
    run: PersistedRunRecord;
    lastEventSeq: number | null;
  }>;
  nextCursor?: string | null;
}): ListRunsResponse {
  return {
    runs: input.runs.map(({ run, lastEventSeq }) =>
      serializeRun(run, lastEventSeq),
    ),
    nextCursor: input.nextCursor ?? null,
  };
}

export function serializeActionRunResponse(input: {
  accepted: boolean;
  run: PersistedRunRecord;
  lastEventSeq: number | null;
}): ActionRunResponse {
  return {
    accepted: input.accepted,
    run: serializeRun(input.run, input.lastEventSeq),
  };
}

export function serializeEventsResponse(events: RunEventRecord[]): EventsResponse {
  return { events };
}
