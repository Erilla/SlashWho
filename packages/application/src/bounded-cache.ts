export type BoundedCacheOutcome =
  "hit" | "miss" | "shared" | "failure" | "capacity";

/**
 * A stored entry is either a loaded value or a remembered rejection. Both live
 * in the same map, so a negative entry takes part in LRU recency, counts
 * against `maxEntries`, and is evicted on exactly the same terms as a value.
 */
type CacheEntry<T> =
  | { kind: "value"; value: T; expiresAt: number }
  | { kind: "failure"; error: unknown; expiresAt: number };

/**
 * Process-local normalized data only. Pending entries are never evicted.
 *
 * Eviction is least-recently-used: a read hit re-inserts its entry so `Map`
 * insertion order is recency order, and eviction drops the entry at the head.
 * A boss every dossier looks up therefore survives, while one looked up once
 * does not displace it. The re-insert carries `expiresAt` over unchanged --
 * an entry's TTL runs from its load, so a hot key still expires and re-fetches
 * on schedule rather than living forever.
 *
 * Expiry is checked lazily, on the entry actually being read. There is no
 * sweep of the whole map on the lookup path: LRU eviction is what bounds
 * memory, and a sweep per lookup cost a full traversal plus one clock read
 * per stored entry.
 */
export function createBoundedCache<T>(options: {
  ttlMs: number;
  maxEntries: number;
  /**
   * TTL for a remembered rejection. Shorter than `ttlMs`: a negative entry
   * suppresses a re-probe of a transient upstream condition, so it should
   * expire well before a genuine value would.
   */
  negativeTtlMs?: number;
  /**
   * Decides whether a rejected load is worth remembering. Without it no
   * failure is ever stored, which is the behaviour every caller had before.
   * A rejection that is remembered is replayed verbatim — the same error
   * instance, carrying whatever the original failure observed, so a replay
   * can never look fresher than the failure that produced it.
   */
  cacheFailure?: (error: unknown) => boolean;
  now?: () => number;
  observe?: (event: BoundedCacheOutcome) => void;
}) {
  const now = options.now ?? Date.now;
  const entries = new Map<string, CacheEntry<T>>();
  const pending = new Map<string, Promise<T>>();
  return async (
    key: string,
    load: () => Promise<T>,
    // Per-call observer: fires in addition to the constructor-level
    // `options.observe` above, attributed only to this specific call
    // (e.g. one HTTP request's measurement scope) rather than broadcast
    // to every caller of the shared cache instance.
    observe?: (event: BoundedCacheOutcome) => void
  ): Promise<T> => {
    const emit = (event: BoundedCacheOutcome) => {
      options.observe?.(event);
      observe?.(event);
    };
    const remember = (entry: CacheEntry<T>) => {
      if (entries.size >= options.maxEntries) {
        entries.delete(entries.keys().next().value!);
      }
      entries.set(key, entry);
    };
    const entry = entries.get(key);
    if (entry) {
      entries.delete(key);
      if (entry.expiresAt > now()) {
        entries.set(key, entry);
        // A replayed rejection is a hit: it cost no upstream call. Reporting
        // it as a repeat `failure` would make the failure counters grow
        // precisely when the cache is doing its job.
        emit("hit");
        if (entry.kind === "failure") throw entry.error;
        return entry.value;
      }
    }
    const active = pending.get(key);
    if (active) {
      emit("shared");
      return active;
    }
    if (pending.size >= options.maxEntries) {
      emit("capacity");
      throw new Error("evidence_cache_capacity");
    }
    emit("miss");
    const request = Promise.resolve()
      .then(load)
      .then((value) => {
        remember({ kind: "value", value, expiresAt: now() + options.ttlMs });
        return value;
      })
      .catch((error: unknown) => {
        emit("failure");
        if (
          options.negativeTtlMs !== undefined &&
          options.cacheFailure?.(error)
        ) {
          remember({
            kind: "failure",
            error,
            expiresAt: now() + options.negativeTtlMs
          });
        }
        throw error;
      })
      .finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  };
}
