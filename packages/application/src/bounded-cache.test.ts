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
  // "a" is the oldest of two entries and still within its negative TTL.
  await expect(cache("a", load)).rejects.toThrow("unavailable");
  expect(calls).toBe(1);

  // A third key pushes the negative entry out, exactly as it would a value.
  await cache("c", async () => 3);
  await expect(cache("a", load)).rejects.toThrow("unavailable");
  expect(calls).toBe(2);
});
