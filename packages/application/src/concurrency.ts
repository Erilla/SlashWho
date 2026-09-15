export type ConcurrencyLimiterOptions = {
  /** Called once per `run`, with the milliseconds spent awaiting admission. */
  onWait?(waitedMs: number): void;
  monotonic?(): number;
};

export function createConcurrencyLimiter(
  limit: number,
  options: ConcurrencyLimiterOptions = {}
) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("concurrency_limit_invalid");
  }

  const monotonic = options.monotonic ?? (() => performance.now());

  let active = 0;
  const pending: Array<{
    work: () => Promise<unknown>;
    queuedAt: number;
    onWait?: (waitedMs: number) => void;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];

  function drain() {
    while (active < limit && pending.length > 0) {
      const item = pending.shift()!;
      active += 1;
      // Reported before the work starts, so the wait never includes it.
      const waitedMs = Math.max(0, Math.round(monotonic() - item.queuedAt));
      // A per-call onWait replaces the constructor-level one for this call,
      // so a scope-bound caller never also feeds the shared reporter.
      (item.onWait ?? options.onWait)?.(waitedMs);
      Promise.resolve()
        .then(item.work)
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  return {
    run<T>(
      work: () => Promise<T>,
      onWait?: (waitedMs: number) => void
    ): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        pending.push({
          work,
          queuedAt: monotonic(),
          onWait,
          resolve: resolve as (value: unknown) => void,
          reject
        });
        drain();
      });
    }
  };
}
