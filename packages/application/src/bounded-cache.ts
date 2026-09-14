/** Process-local normalized data only. Pending entries are never evicted. */
export function createBoundedCache<T>(options: {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
  observe?: (event: "hit" | "miss" | "shared" | "failure" | "capacity") => void;
}) {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: T; expiresAt: number }>();
  const pending = new Map<string, Promise<T>>();
  return async (key: string, load: () => Promise<T>): Promise<T> => {
    for (const [storedKey, entry] of entries) {
      if (entry.expiresAt <= now()) entries.delete(storedKey);
    }
    const entry = entries.get(key);
    if (entry) {
      options.observe?.("hit");
      return entry.value;
    }
    const active = pending.get(key);
    if (active) {
      options.observe?.("shared");
      return active;
    }
    if (pending.size >= options.maxEntries) {
      options.observe?.("capacity");
      throw new Error("evidence_cache_capacity");
    }
    options.observe?.("miss");
    const request = Promise.resolve()
      .then(load)
      .then((value) => {
        if (entries.size >= options.maxEntries) {
          entries.delete(entries.keys().next().value!);
        }
        entries.set(key, { value, expiresAt: now() + options.ttlMs });
        return value;
      })
      .catch((error: unknown) => {
        options.observe?.("failure");
        throw error;
      })
      .finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  };
}
