import type { AgentProvider, RunStatus, WorkPhase } from "../../domain-model.js";
import type {
  PersistedRunRecord,
  RunEventRecord,
  RuntimeCapacitySnapshot,
  RuntimeReadinessSnapshot,
} from "../types.js";

export type RuntimeApiRun = PersistedRunRecord & {
  lastEventSeq: number | null;
};

export type CreateRunResponse = {
  created: boolean;
  run: RuntimeApiRun;
};

export type GetRunResponse = {
  run: RuntimeApiRun;
};

export type ListRunsResponse = {
  runs: RuntimeApiRun[];
  nextCursor?: string | null;
};

export type ActionRunResponse = {
  accepted: boolean;
  run: RuntimeApiRun;
};

export type EventsResponse = {
  events: RunEventRecord[];
};

export type HealthResponse = RuntimeReadinessSnapshot;

export type CapacityResponse = RuntimeCapacitySnapshot;

export type ErrorResponse = {
  error: {
    code: string;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
};

export type ListRunsQuery = {
  status?: RunStatus;
  provider?: AgentProvider;
  workItemId?: string;
  phase?: WorkPhase;
  repoRoot?: string;
  limit?: number;
  cursor?: string;
};

export type ListRunEventsQuery = {
  after?: number;
  limit?: number;
  waitMs?: number;
};

export type RuntimeApiListenOptions =
  | {
      kind: "socket";
      socketPath: string;
    }
  | {
      kind: "pipe";
      pipeName: string;
    }
  | {
      kind: "tcp";
      host: string;
      port: number;
    };

export type RuntimeApiServerInfo = {
  endpoint: string;
  listening: boolean;
};

export type RuntimeApiRequestBody = Record<string, unknown> | null;
