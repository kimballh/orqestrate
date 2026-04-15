import type { AgentProvider, RunStatus, WorkPhase } from "../domain-model.js";
import type { RuntimeApiRun } from "../runtime/api/types.js";
import type { RuntimeDaemon } from "../runtime/daemon.js";
import type {
  RunEventRecord,
  RuntimeReadinessSnapshot,
} from "../runtime/types.js";

export type ObservedRuntimeRun = RuntimeApiRun;

export type ListObservedRunsInput = {
  status?: RunStatus;
  provider?: AgentProvider;
  workItemId?: string;
  phase?: WorkPhase;
  repoRoot?: string;
  limit: number;
  cursor?: string;
};

export type ListObservedRunEventsInput = {
  after?: number;
  limit?: number;
};

export type ListObservedRunsResult = {
  runs: ObservedRuntimeRun[];
  nextCursor?: string | null;
};

export interface RuntimeObserver {
  getRun(runId: string): Promise<ObservedRuntimeRun | null>;
  listRuns(input: ListObservedRunsInput): Promise<ListObservedRunsResult>;
  listRunEvents(
    runId: string,
    input?: ListObservedRunEventsInput,
  ): Promise<RunEventRecord[]>;
  getHealth(): Promise<RuntimeReadinessSnapshot>;
}

type RuntimeDaemonObserverInput = {
  daemon: Pick<
    RuntimeDaemon,
    "getRun" | "getRunLastEventSeq" | "listRunsPage" | "listRunEvents" | "getReadinessSnapshot"
  >;
  transportReady?: boolean;
};

export class RuntimeDaemonObserver implements RuntimeObserver {
  private readonly daemon: RuntimeDaemonObserverInput["daemon"];
  private readonly transportReady: boolean;

  constructor(input: RuntimeDaemonObserverInput) {
    this.daemon = input.daemon;
    this.transportReady = input.transportReady ?? true;
  }

  async getRun(runId: string): Promise<ObservedRuntimeRun | null> {
    const run = this.daemon.getRun(runId);

    if (run === null) {
      return null;
    }

    return {
      ...run,
      lastEventSeq: this.daemon.getRunLastEventSeq(runId),
    };
  }

  async listRuns(input: ListObservedRunsInput): Promise<ListObservedRunsResult> {
    const page = this.daemon.listRunsPage({
      status: input.status,
      provider: input.provider,
      workItemId: input.workItemId,
      phase: input.phase,
      repoRoot: input.repoRoot,
      limit: input.limit,
      cursor: input.cursor,
    });

    return {
      runs: page.runs.map((run) => ({
        ...run,
        lastEventSeq: this.daemon.getRunLastEventSeq(run.runId),
      })),
      nextCursor: page.nextCursor ?? null,
    };
  }

  async listRunEvents(
    runId: string,
    input: ListObservedRunEventsInput = {},
  ): Promise<RunEventRecord[]> {
    return this.daemon.listRunEvents(runId, {
      afterSeq: input.after,
      limit: input.limit,
    });
  }

  async getHealth(): Promise<RuntimeReadinessSnapshot> {
    return this.daemon.getReadinessSnapshot({
      transportReady: this.transportReady,
    });
  }
}
