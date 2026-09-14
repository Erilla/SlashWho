/** Process-local normalized data only. Failed loads are never cached. */
export function createBoundedCache<T>(options: {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: T; expiresAt: number }>();
  const pending = new Map<string, Promise<T>>();

  return async (key: string, load: () => Promise<T>): Promise<T> => {
    for (const [storedKey, entry] of entries) {
      if (entry.expiresAt <= now()) entries.delete(storedKey);
    }
    const entry = entries.get(key);
    if (entry) return entry.value;

    const active = pending.get(key);
    if (active) return active;
    if (pending.size >= options.maxEntries) {
      throw new Error("evidence_cache_capacity");
    }

    const request = Promise.resolve()
      .then(load)
      .then((value) => {
        if (entries.size >= options.maxEntries) {
          entries.delete(entries.keys().next().value!);
        }
        entries.set(key, { value, expiresAt: now() + options.ttlMs });
        return value;
      })
      .finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  };
}
