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
