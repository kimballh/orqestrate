type LiveRunContext<TContext> = {
  runId: string;
  sessionId: string;
  value: TContext;
};

export class LiveRunRegistry<TContext> {
  private readonly byRunId = new Map<string, LiveRunContext<TContext>>();
  private readonly bySessionId = new Map<string, LiveRunContext<TContext>>();

  add(runId: string, sessionId: string, value: TContext): void {
    const context = { runId, sessionId, value };
    this.byRunId.set(runId, context);
    this.bySessionId.set(sessionId, context);
  }

  getByRunId(runId: string): TContext | null {
    return this.byRunId.get(runId)?.value ?? null;
  }

  getBySessionId(sessionId: string): TContext | null {
    return this.bySessionId.get(sessionId)?.value ?? null;
  }

  removeByRunId(runId: string): TContext | null {
    const context = this.byRunId.get(runId);

    if (context === undefined) {
      return null;
    }

    this.byRunId.delete(runId);
    this.bySessionId.delete(context.sessionId);
    return context.value;
  }

  list(): TContext[] {
    return [...this.byRunId.values()].map((context) => context.value);
  }
}
