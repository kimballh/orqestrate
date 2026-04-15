import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

const PROCESS_BOOT_ID = randomUUID();
const DEFAULT_OWNER_SCOPE = "default";

export function createOrchestratorOwner(scope: string = DEFAULT_OWNER_SCOPE): string {
  return `orchestrator:${scope}:${hostname()}:${process.pid}:${PROCESS_BOOT_ID}`;
}

export function createRunId(): string {
  return randomUUID();
}

export function computeLeaseUntil(
  now: Date,
  leaseDurationMs: number,
): string {
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error("leaseDurationMs must be a positive finite number.");
  }

  return new Date(now.getTime() + leaseDurationMs).toISOString();
}
