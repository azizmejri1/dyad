// Shared request budgets for a live campaign: a token bucket per provider
// surface (Management API, Auth) and a concurrency cap for SQL. Polling and
// retries draw from the same budgets as the operations under test.
//
// Relative imports only: the supervisor CLI loads this through jiti.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private blockedUntil = 0;
  private rate: number;
  private queue: Promise<void> = Promise.resolve();
  /** Times this bucket slowed down because the provider throttled us. */
  throttleEvents = 0;

  constructor(
    readonly name: string,
    private readonly baseRatePerSecond: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
    this.rate = baseRatePerSecond;
  }

  get currentRatePerSecond(): number {
    return this.rate;
  }

  /** Waits for a token. Callers are served FIFO. */
  take(): Promise<void> {
    const next = this.queue.then(() => this.waitForToken());
    // Keep the chain alive even if a waiter is abandoned.
    this.queue = next.catch(() => {});
    return next;
  }

  private async waitForToken(): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (now < this.blockedUntil) {
        await sleep(this.blockedUntil - now);
        continue;
      }
      this.tokens = Math.min(
        this.burst,
        this.tokens + ((now - this.last) / 1000) * this.rate,
      );
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - this.tokens) / this.rate) * 1000));
    }
  }

  /**
   * Provider throttling (429): honor Retry-After when present and halve the
   * rate. The rate recovers slowly on success via `onSuccess`.
   */
  onThrottle(retryAfterSeconds?: number): void {
    this.throttleEvents += 1;
    this.rate = Math.max(this.baseRatePerSecond / 8, this.rate / 2);
    const waitMs =
      retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1000
        : 2000;
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + waitMs);
    this.tokens = 0;
  }

  onSuccess(): void {
    if (this.rate < this.baseRatePerSecond) {
      this.rate = Math.min(this.baseRatePerSecond, this.rate * 1.05);
    }
  }
}

export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  peak = 0;

  constructor(
    readonly name: string,
    private readonly limit: number,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

/** Parses Retry-After (seconds or HTTP date). */
export function parseRetryAfter(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(String(value));
  if (Number.isFinite(date)) return Math.max(0, (date - Date.now()) / 1000);
  return undefined;
}
