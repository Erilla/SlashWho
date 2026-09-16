import { expect, it, vi } from "vitest";
import { createBoundedCache } from "./bounded-cache";

it("reuses concurrent loads and expires normalized values", async () => {
  let now = 0;
  const cache = createBoundedCache<number>({
    ttlMs: 10,
    maxEntries: 2,
    now: () => now
  });
  let calls = 0;
  const load = async () => ++calls;
  expect(await Promise.all([cache("a", load), cache("a", load)])).toEqual([
    1, 1
  ]);
  expect(await cache("a", load)).toBe(1);
  now = 10;
  expect(await cache("a", load)).toBe(2);
});

it("evicts old entries and never caches failures as negative evidence", async () => {
  const cache = createBoundedCache<number>({ ttlMs: 10_000, maxEntries: 1 });
  await expect(
    cache("a", async () => {
      throw new Error("offline");
    })
  ).rejects.toThrow("offline");
  expect(await cache("a", async () => 1)).toBe(1);
  await cache("b", async () => 2);
  expect(await cache("a", async () => 3)).toBe(3);
});

it("bounds concurrent distinct loads without duplicating a pending load", async () => {
  const events = vi.fn();
  const cache = createBoundedCache<number>({
    ttlMs: 10,
    maxEntries: 1,
    observe: events
  });
  let finish!: (value: number) => void;
  const first = cache(
    "a",
    () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      })
  );
  await expect(cache("b", async () => 2)).rejects.toThrow(
    "evidence_cache_capacity"
  );
  finish(1);
  expect(await first).toBe(1);
  expect(events).toHaveBeenCalledWith("capacity");
});

it("notifies a per-call observer in addition to the constructor-level one", async () => {
  const constructorEvents = vi.fn();
  const cache = createBoundedCache<number>({
    ttlMs: 10_000,
    maxEntries: 2,
    observe: constructorEvents
  });
  const callerAEvents = vi.fn();
  const callerBEvents = vi.fn();

  expect(await cache("a", async () => 1, callerAEvents)).toBe(1);
  expect(await cache("b", async () => 2, callerBEvents)).toBe(2);
  expect(await cache("a", async () => 3, callerBEvents)).toBe(1);

  expect(callerAEvents).toHaveBeenCalledWith("miss");
  expect(callerAEvents).not.toHaveBeenCalledWith("hit");
  expect(callerBEvents).toHaveBeenCalledWith("miss");
  expect(callerBEvents).toHaveBeenCalledWith("hit");
  // The constructor-level observer keeps receiving every outcome, unchanged.
  expect(constructorEvents).toHaveBeenCalledWith("miss");
  expect(constructorEvents).toHaveBeenCalledWith("hit");
});

it("replays a remembered failure without re-running the load", async () => {
  let now = 0;
  let calls = 0;
  const cache = createBoundedCache<number>({
    ttlMs: 10_000,
    maxEntries: 4,
    negativeTtlMs: 100,
    cacheFailure: (error) => (error as Error).message === "unavailable",
    now: () => now
  });
  const load = async () => {
    calls += 1;
    throw new Error("unavailable");
  };

  await expect(cache("a", load)).rejects.toThrow("unavailable");
  await expect(cache("a", load)).rejects.toThrow("unavailable");
  expect(calls).toBe(1);

  now = 100;
  await expect(cache("a", load)).rejects.toThrow("unavailable");
  expect(calls).toBe(2);
});

it("replays the original rejection value, not a fresh one", async () => {
  const thrown: Error[] = [];
  const cache = createBoundedCache<number>({
    ttlMs: 10_000,
    maxEntries: 4,
    negativeTtlMs: 100,
    cacheFailure: () => true
  });
  // A new error object per call, so a replay that re-ran the load would hand
  // back a different instance — which is what a stale timestamp would look like.
  const load = async () => {
    const failure = new Error("unavailable");
    thrown.push(failure);
    throw failure;
  };

  const first = await cache("a", load).catch((error: unknown) => error);
  const replayed = await cache("a", load).catch((error: unknown) => error);

  expect(thrown).toHaveLength(1);
  expect(replayed).toBe(first);
});

it("remembers only the failures cacheFailure accepts", async () => {
  const calls = { unavailable: 0, drift: 0 };
  const cache = createBoundedCache<number>({
    ttlMs: 10_000,
    maxEntries: 4,
    negativeTtlMs: 100,
    cacheFailure: (error) => (error as Error).message === "unavailable"
  });
  const unavailable = async () => {
    calls.unavailable += 1;
    throw new Error("unavailable");
  };
  const drift = async () => {
    calls.drift += 1;
    throw new Error("schema_drift");
  };

  await expect(cache("a", unavailable)).rejects.toThrow("unavailable");
  await expect(cache("a", unavailable)).rejects.toThrow("unavailable");
  await expect(cache("b", drift)).rejects.toThrow("schema_drift");
  await expect(cache("b", drift)).rejects.toThrow("schema_drift");

  expect(calls).toEqual({ unavailable: 1, drift: 2 });
});

it("reports a remembered failure as a hit, not a repeat failure", async () => {
  const events = vi.fn();
  const cache = createBoundedCache<number>({
    ttlMs: 10_000,
    maxEntries: 4,
    negativeTtlMs: 100,
    cacheFailure: () => true,
    observe: events
  });
  const load = async () => {
    throw new Error("unavailable");
  };

  await expect(cache("a", load)).rejects.toThrow("unavailable");
  events.mockClear();
  await expect(cache("a", load)).rejects.toThrow("unavailable");

  expect(events).toHaveBeenCalledWith("hit");
  expect(events).not.toHaveBeenCalledWith("failure");
});

it("counts a negative entry against capacity and evicts it in turn", async () => {
  let calls = 0;
  const cache = createBoundedCache<number>({
    ttlMs: 10_000,
    maxEntries: 2,
    negativeTtlMs: 10_000,
    cacheFailure: () => true
  });
  const load = async () => {
    calls += 1;
    throw new Error("unavailable");
  };

  await expect(cache("a", load)).rejects.toThrow("unavailable");
  await cache("b", async () => 2);
  // Never read again, the negative entry is the least recently used of the
  // two, so a third key pushes it out exactly as it would a value.
  await cache("c", async () => 3);

  await expect(cache("a", load)).rejects.toThrow("unavailable");
  expect(calls).toBe(2);
  // "b" and "c" occupied the two slots, so the negative entry really was the
  // one evicted rather than simply having expired.
  expect(await cache("c", async () => 99)).toBe(3);
});

it("keeps a negative entry in LRU recency order like any other entry", async () => {
  // #242 x #243: a negative entry must take part in recency, not just in
  // sizing. A remembered failure that is read every time must outlive a value
  // that is not, or the read path re-probes exactly the lookup it remembered.
  let calls = 0;
  const cache = createBoundedCache<number>({
    ttlMs: 10_000,
    maxEntries: 2,
    negativeTtlMs: 10_000,
    cacheFailure: () => true
  });
  const load = async () => {
    calls += 1;
    throw new Error("unavailable");
  };

  await expect(cache("hot", load)).rejects.toThrow("unavailable");
  await cache("cold", async () => 2);
  // Replaying the negative entry promotes it, making "cold" least recent.
  await expect(cache("hot", load)).rejects.toThrow("unavailable");

  await cache("newest", async () => 3);

  // "cold" was evicted; the negative entry survived on recency.
  await expect(cache("hot", load)).rejects.toThrow("unavailable");
  expect(calls).toBe(1);
  expect(await cache("cold", async () => 4)).toBe(4);
});

it("evicts the least recently read entry rather than the oldest inserted", async () => {
  // Break caught: FIFO eviction drops a boss every dossier looks up as
  // readily as one looked up once, so a working set larger than
  // `maxEntries` evicts exactly the entries most worth keeping.
  const cache = createBoundedCache<number>({ ttlMs: 10_000, maxEntries: 2 });
  await cache("hot", async () => 1);
  await cache("cold", async () => 2);
  // Reading "hot" again makes "cold" the least recently used entry.
  expect(await cache("hot", async () => 99)).toBe(1);

  await cache("newest", async () => 3);

  expect(await cache("hot", async () => 99)).toBe(1);
  expect(await cache("cold", async () => 4)).toBe(4);
});

it("does not extend an entry's TTL when a read hits it", async () => {
  // Break caught: re-inserting on hit to maintain recency order could
  // re-stamp `expiresAt`, so a hot key would never expire and would serve
  // indefinitely stale upstream data instead of re-fetching on schedule.
  let clock = 0;
  const cache = createBoundedCache<number>({
    ttlMs: 10,
    maxEntries: 2,
    now: () => clock
  });
  expect(await cache("a", async () => 1)).toBe(1);
  clock = 9;
  expect(await cache("a", async () => 2)).toBe(1);

  clock = 10;

  expect(await cache("a", async () => 3)).toBe(3);
});

it("reads the clock once per lookup rather than once per stored entry", async () => {
  // Break caught: sweeping every entry on every lookup, with the clock read
  // inside the loop, costs a full map traversal and one `Date.now()` per
  // stored entry per lookup — tens of thousands of clock reads per dossier.
  const clock = vi.fn(() => 0);
  const cache = createBoundedCache<number>({
    ttlMs: 10_000,
    maxEntries: 50,
    now: clock
  });
  for (let index = 0; index < 20; index += 1) {
    await cache(`key-${index}`, async () => index);
  }
  clock.mockClear();

  expect(await cache("key-0", async () => -1)).toBe(0);

  expect(clock).toHaveBeenCalledTimes(1);
});

it("reloads an expired entry in place rather than evicting a live one", async () => {
  // Break caught: moving the unconditional `entries.delete(key)` inside the
  // live branch looks like a simplification, but then an expired entry is
  // still occupying a slot when its reload stores. Capacity eviction fires
  // and takes the head -- a live entry -- while `Map.set` rewrites the
  // expired key in place, so the cache loses a good entry to refresh a dead
  // one.
  let clock = 0;
  const cache = createBoundedCache<string>({
    ttlMs: 10,
    maxEntries: 2,
    now: () => clock
  });
  await cache("stale", async () => "stale-1");
  clock = 5;
  await cache("live", async () => "live-1");
  clock = 6;
  // Promote "stale" so the live entry, not the expiring one, sits at the head.
  expect(await cache("stale", async () => "unused")).toBe("stale-1");

  clock = 12;
  expect(await cache("stale", async () => "stale-2")).toBe("stale-2");

  expect(await cache("live", async () => "live-2")).toBe("live-1");
});

it("reports a read of an expired entry as a miss rather than a hit", async () => {
  // Break caught: expiry moved from a sweep to a check on the entry being
  // read, so the expired-read path is the one whose control flow changed;
  // callers' hit/miss accounting must not shift with it.
  const events = vi.fn();
  let clock = 0;
  const cache = createBoundedCache<number>({
    ttlMs: 10,
    maxEntries: 2,
    now: () => clock,
    observe: events
  });
  await cache("a", async () => 1);
  events.mockClear();

  clock = 10;
  expect(await cache("a", async () => 2)).toBe(2);

  expect(events).toHaveBeenCalledWith("miss");
  expect(events).not.toHaveBeenCalledWith("hit");
});

it("reads the clock a bounded number of times when an expired entry reloads", async () => {
  // Break caught: the hit path alone would not notice a sweep reintroduced
  // on the miss/expired path, which is where the old per-entry clock read
  // cost the most.
  let clock = 0;
  const reads = vi.fn(() => clock);
  const cache = createBoundedCache<number>({
    ttlMs: 10,
    maxEntries: 50,
    now: reads
  });
  for (let index = 0; index < 20; index += 1) {
    await cache(`key-${index}`, async () => index);
  }
  clock = 10;
  reads.mockClear();

  expect(await cache("key-0", async () => -1)).toBe(-1);

  // One read for the expiry check, one to stamp the reloaded entry.
  expect(reads).toHaveBeenCalledTimes(2);
});
