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
