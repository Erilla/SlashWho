export function createConcurrencyLimiter(limit: number) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("concurrency_limit_invalid");
  }

  let active = 0;
  const pending: Array<{
    work: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];

  function drain() {
    while (active < limit && pending.length > 0) {
      const item = pending.shift()!;
      active += 1;
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
    run<T>(work: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        pending.push({
          work,
          resolve: resolve as (value: unknown) => void,
          reject
        });
        drain();
      });
    }
  };
}
