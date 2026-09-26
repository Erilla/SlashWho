export type RequestLimits = Readonly<{
  /** Requests allowed in flight at once across every caller of the client. */
  maxConcurrent: number;
  /** Requests allowed to start within any one-second window. */
  maxPerSecond: number;
}>;

export type RequestLimiter = {
  /**
   * Waits for a slot and resolves with its release. The caller must release
   * the slot exactly once, however its request ends; a second call is a no-op.
   */
  acquire(signal?: AbortSignal): Promise<() => void>;
  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
};

type Waiter = {
  start(): void;
  cancel(reason: unknown): void;
};

const WINDOW_MS = 1_000;

function validLimit(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`blizzard_${name}_invalid`);
  }
  return value;
}

/**
 * Admits requests in arrival order while fewer than `maxConcurrent` are in
 * flight and fewer than `maxPerSecond` started in the trailing second.
 *
 * A concurrency cap alone does not bound the rate: in flight divided by
 * latency rises without limit as answers get faster, and Blizzard answers a
 * burst over its per-second limit with 429s for the rest of that second. The
 * window slides rather than resetting on the second, so no one-second span,
 * wherever it falls, sees more than `maxPerSecond` starts.
 */
export function createRequestLimiter(limits: RequestLimits): RequestLimiter {
  const maxConcurrent = validLimit(limits.maxConcurrent, "max_concurrent");
  const maxPerSecond = validLimit(limits.maxPerSecond, "max_per_second");
  const queue: Waiter[] = [];
  const recentStarts: number[] = [];
  let active = 0;
  let timerPending = false;

  function drain(): void {
    while (queue.length > 0 && active < maxConcurrent) {
      const now = Date.now();
      while (recentStarts.length > 0 && recentStarts[0]! <= now - WINDOW_MS) {
        recentStarts.shift();
      }
      if (recentStarts.length >= maxPerSecond) {
        if (!timerPending) {
          timerPending = true;
          setTimeout(
            () => {
              timerPending = false;
              drain();
            },
            recentStarts[0]! + WINDOW_MS - now
          );
        }
        return;
      }
      recentStarts.push(now);
      active += 1;
      queue.shift()!.start();
    }
  }

  function acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise<() => void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        const index = queue.indexOf(waiter);
        if (index === -1) return;
        queue.splice(index, 1);
        waiter.cancel(signal!.reason);
      };
      const waiter: Waiter = {
        start() {
          signal?.removeEventListener("abort", onAbort);
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            active -= 1;
            drain();
          });
        },
        cancel(reason) {
          signal?.removeEventListener("abort", onAbort);
          reject(reason);
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(waiter);
      drain();
    });
  }

  return {
    acquire,
    async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      const release = await acquire(signal);
      try {
        return await work();
      } finally {
        release();
      }
    }
  };
}
