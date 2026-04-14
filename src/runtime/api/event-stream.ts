import type { ServerResponse } from "node:http";

import type { RuntimeDaemon } from "../daemon.js";
import type { RunEventRecord } from "../types.js";

type WaitForEventsInput = {
  daemon: RuntimeDaemon;
  runId: string;
  afterSeq?: number;
  limit?: number;
  waitMs?: number;
  shouldStop?: () => boolean;
  pollIntervalMs?: number;
};

export async function waitForEvents(
  input: WaitForEventsInput,
): Promise<RunEventRecord[]> {
  const startedAt = Date.now();
  const pollIntervalMs = input.pollIntervalMs ?? 50;

  while (true) {
    const events = input.daemon.listRunEvents(input.runId, {
      afterSeq: input.afterSeq,
      limit: input.limit,
    });

    if (events.length > 0) {
      return events;
    }

    if (input.waitMs === undefined || input.waitMs <= 0) {
      return events;
    }

    if (input.shouldStop?.() === true) {
      return [];
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= input.waitMs) {
      return [];
    }

    await sleep(Math.min(pollIntervalMs, input.waitMs - elapsedMs));
  }
}

export function writeSseEvent(
  response: ServerResponse,
  event: RunEventRecord,
): void {
  response.write(`id: ${event.seq}\n`);
  response.write(`event: ${event.eventType}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
