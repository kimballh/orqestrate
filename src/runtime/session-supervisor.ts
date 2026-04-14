export type LaunchSpec = {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  cols?: number;
  rows?: number;
};

export type SessionOutputChunk = {
  sessionId: string;
  occurredAt: string;
  chunk: string;
};

export type SessionExit = {
  sessionId: string;
  occurredAt: string;
  exitCode: number | null;
  signal?: string | null;
};

export type SessionObserver = {
  runId: string;
  onOutput(event: SessionOutputChunk): void | Promise<void>;
  onExit(event: SessionExit): void | Promise<void>;
};

export type LiveSessionHandle = {
  sessionId: string;
  pid: number;
  runId: string;
};

export type SessionSnapshot = {
  sessionId: string;
  runId: string;
  pid: number;
  recentOutput: string;
  bytesRead: number;
  bytesWritten: number;
  isAlive: boolean;
  startedAt: string;
  lastOutputAt?: string | null;
  lastInputAt?: string | null;
};

export interface SessionSupervisor {
  launch(spec: LaunchSpec, observer: SessionObserver): Promise<LiveSessionHandle>;
  write(sessionId: string, input: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  terminate(sessionId: string, force?: boolean): Promise<void>;
  snapshot(sessionId: string): Promise<SessionSnapshot>;
  readRecentOutput(sessionId: string, maxChars: number): Promise<string>;
}
