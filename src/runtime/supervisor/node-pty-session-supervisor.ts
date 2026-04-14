import process from "node:process";
import { randomUUID } from "node:crypto";

import * as pty from "node-pty";

import { RuntimeError } from "../errors.js";
import type {
  LaunchSpec,
  LiveSessionHandle,
  SessionExit,
  SessionObserver,
  SessionSnapshot,
  SessionSupervisor,
} from "../session-supervisor.js";

type NodePtySessionRecord = {
  handle: pty.IPty;
  observer: SessionObserver;
  runId: string;
  sessionId: string;
  pid: number;
  startedAt: string;
  bytesRead: number;
  bytesWritten: number;
  lastOutputAt?: string | null;
  lastInputAt?: string | null;
  recentOutput: string;
  isAlive: boolean;
  exit?: SessionExit | null;
};

const DEFAULT_BUFFER_SIZE = 32_768;

export class NodePtySessionSupervisor implements SessionSupervisor {
  private readonly sessions = new Map<string, NodePtySessionRecord>();

  constructor(private readonly maxRecentOutputChars = DEFAULT_BUFFER_SIZE) {}

  async launch(
    spec: LaunchSpec,
    observer: SessionObserver,
  ): Promise<LiveSessionHandle> {
    const sessionId = randomUUID();
    const startedAt = new Date().toISOString();
    const handle = pty.spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      cols: spec.cols ?? 120,
      rows: spec.rows ?? 30,
      name: "xterm-color",
    });

    const record: NodePtySessionRecord = {
      handle,
      observer,
      runId: observer.runId,
      sessionId,
      pid: handle.pid,
      startedAt,
      bytesRead: 0,
      bytesWritten: 0,
      lastOutputAt: null,
      lastInputAt: null,
      recentOutput: "",
      isAlive: true,
      exit: null,
    };

    handle.onData((chunk) => {
      const occurredAt = new Date().toISOString();
      record.bytesRead += Buffer.byteLength(chunk);
      record.lastOutputAt = occurredAt;
      record.recentOutput = trimRecentOutput(
        `${record.recentOutput}${chunk}`,
        this.maxRecentOutputChars,
      );
      void observer.onOutput({
        sessionId,
        occurredAt,
        chunk,
      });
    });

    handle.onExit((event) => {
      const occurredAt = new Date().toISOString();
      record.isAlive = false;
      record.exit = {
        sessionId,
        occurredAt,
        exitCode: event.exitCode,
        signal:
          typeof event.signal === "number"
            ? String(event.signal)
            : event.signal ?? null,
      };
      void observer.onExit(record.exit);
    });

    this.sessions.set(sessionId, record);

    return {
      sessionId,
      pid: handle.pid,
      runId: observer.runId,
    };
  }

  async write(sessionId: string, input: string): Promise<void> {
    const record = this.getSession(sessionId);
    record.handle.write(input);
    record.bytesWritten += Buffer.byteLength(input);
    record.lastInputAt = new Date().toISOString();
  }

  async interrupt(sessionId: string): Promise<void> {
    const record = this.getSession(sessionId);

    if (!record.isAlive) {
      return;
    }

    record.handle.kill("SIGINT");
  }

  async terminate(sessionId: string, force = false): Promise<void> {
    const record = this.getSession(sessionId);

    if (record.isAlive) {
      record.handle.kill(force ? "SIGKILL" : "SIGTERM");
      if (force) {
        record.isAlive = false;
      }
    }

    if (!record.isAlive) {
      this.sessions.delete(sessionId);
    }
  }

  async snapshot(sessionId: string): Promise<SessionSnapshot> {
    const record = this.getSession(sessionId);

    return {
      sessionId: record.sessionId,
      runId: record.runId,
      pid: record.pid,
      recentOutput: record.recentOutput,
      bytesRead: record.bytesRead,
      bytesWritten: record.bytesWritten,
      isAlive: record.isAlive,
      startedAt: record.startedAt,
      lastOutputAt: record.lastOutputAt,
      lastInputAt: record.lastInputAt,
    };
  }

  async readRecentOutput(
    sessionId: string,
    maxChars: number,
  ): Promise<string> {
    return trimRecentOutput(this.getSession(sessionId).recentOutput, maxChars);
  }

  private getSession(sessionId: string): NodePtySessionRecord {
    const record = this.sessions.get(sessionId);

    if (record === undefined) {
      throw new RuntimeError(`Session '${sessionId}' was not found.`, {
        code: "live_session_not_found",
      });
    }

    return record;
  }
}

function trimRecentOutput(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(value.length - maxChars);
}
