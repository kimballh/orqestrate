import type {
  ProcessWakeupResult,
  WakeupEventRecord,
} from "./wakeup-types.js";
import { WakeupRepository } from "./wakeup-repository.js";

export type WakeupProcessorLike = {
  process(event: WakeupEventRecord): Promise<ProcessWakeupResult>;
};

export type WakeupLoopDependencies = {
  repository: WakeupRepository;
  processor: WakeupProcessorLike;
  owner: string;
  intervalMs?: number;
  maxBatchSize?: number;
  maxAttempts?: number;
  retryBackoffMs?: (attempts: number) => number;
  now?: () => Date;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
};

export class WakeupLoop {
  private readonly intervalMs: number;
  private readonly maxBatchSize: number;
  private readonly maxAttempts: number;
  private readonly retryBackoffMs: (attempts: number) => number;
  private readonly now: () => Date;
  private readonly setIntervalFn: typeof globalThis.setInterval;
  private readonly clearIntervalFn: typeof globalThis.clearInterval;
  private timer: ReturnType<typeof globalThis.setInterval> | null = null;

  constructor(private readonly dependencies: WakeupLoopDependencies) {
    this.intervalMs = dependencies.intervalMs ?? 1_000;
    this.maxBatchSize = dependencies.maxBatchSize ?? 10;
    this.maxAttempts = dependencies.maxAttempts ?? 5;
    this.retryBackoffMs =
      dependencies.retryBackoffMs ?? defaultRetryBackoffMs;
    this.now = dependencies.now ?? (() => new Date());
    this.setIntervalFn = dependencies.setInterval ?? globalThis.setInterval;
    this.clearIntervalFn =
      dependencies.clearInterval ?? globalThis.clearInterval;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }

    this.timer = this.setIntervalFn(() => {
      void this.runOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer === null) {
      return;
    }

    this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<ProcessWakeupResult[]> {
    const results: ProcessWakeupResult[] = [];

    for (let index = 0; index < this.maxBatchSize; index += 1) {
      const event = this.dependencies.repository.claimNext(
        this.dependencies.owner,
        this.now().toISOString(),
      );

      if (event === null) {
        break;
      }

      try {
        const result = await this.dependencies.processor.process(event);
        this.dependencies.repository.markDone(event.eventId, this.now().toISOString());
        results.push(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Wakeup processing failed.";

        if (event.attempts >= this.maxAttempts) {
          this.dependencies.repository.markDeadLetter(
            event.eventId,
            message,
            this.now().toISOString(),
          );
          continue;
        }

        const retryAt = new Date(
          this.now().getTime() + this.retryBackoffMs(event.attempts),
        ).toISOString();

        this.dependencies.repository.requeue({
          eventId: event.eventId,
          availableAt: retryAt,
          lastError: message,
        });
      }
    }

    return results;
  }
}

function defaultRetryBackoffMs(attempts: number): number {
  return Math.min(60_000, 1_000 * Math.max(1, attempts));
}
