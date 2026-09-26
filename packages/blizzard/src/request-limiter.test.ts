import {
  discoverFingerprintMatches,
  type CharacterKey
} from "@slashwho/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBlizzardClient } from "./index";
import { createRequestLimiter } from "./request-limiter";

function busiestSecond(starts: readonly number[]): number {
  const sorted = [...starts].sort((left, right) => left - right);
  let busiest = 0;
  for (const [index, start] of sorted.entries()) {
    let count = 0;
    for (let next = index; next < sorted.length; next += 1) {
      if (sorted[next]! >= start + 1_000) break;
      count += 1;
    }
    busiest = Math.max(busiest, count);
  }
  return busiest;
}

async function runUntilSettled(work: Promise<unknown>): Promise<void> {
  let done = false;
  const settle = () => {
    done = true;
  };
  work.then(settle, settle);
  for (let step = 0; step < 10_000 && !done; step += 1) {
    await vi.advanceTimersByTimeAsync(10);
  }
  expect(done).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createRequestLimiter", () => {
  it("starts no more than the concurrency limit at once", async () => {
    // Break caught: a limiter that admits a burst past its slots, or one that
    // never frees a slot when work fails.
    const limiter = createRequestLimiter({
      maxConcurrent: 3,
      maxPerSecond: 100
    });
    let inFlight = 0;
    let peak = 0;
    const work = Array.from({ length: 10 }, (_, index) =>
      limiter.run(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        if (index % 4 === 0) throw new Error("upstream");
        return index;
      })
    );

    const all = Promise.allSettled(work);
    await runUntilSettled(all);

    expect(peak).toBe(3);
    expect((await all).map((result) => result.status)).toEqual(
      Array.from({ length: 10 }, (_, index) =>
        index % 4 === 0 ? "rejected" : "fulfilled"
      )
    );
  });

  it("starts no more than the rate limit in any one-second window", async () => {
    // Break caught: a fixed window reset on the second admits twice the limit
    // across a boundary; instant answers would otherwise go as fast as the
    // concurrency slots turn over.
    const limiter = createRequestLimiter({
      maxConcurrent: 50,
      maxPerSecond: 20
    });
    const starts: number[] = [];
    const all = Promise.all(
      Array.from({ length: 70 }, () =>
        limiter.run(async () => {
          starts.push(Date.now());
        })
      )
    );

    await runUntilSettled(all);

    expect(starts).toHaveLength(70);
    expect(busiestSecond(starts)).toBe(20);
    // Not slower than it has to be: 70 starts at 20 a second need 3 seconds.
    expect(Math.max(...starts)).toBeLessThanOrEqual(3_010);
  });

  it("drops a queued request whose signal aborts without spending its slot", async () => {
    // Break caught: an aborted job's reads staying queued and later running
    // against Blizzard for a sweep nobody is waiting on.
    const limiter = createRequestLimiter({
      maxConcurrent: 1,
      maxPerSecond: 20
    });
    const controller = new AbortController();
    let release!: () => void;
    const first = limiter.run(
      () => new Promise<void>((resolve) => (release = resolve))
    );
    const ran = vi.fn(async () => undefined);
    const queued = limiter.run(ran, controller.signal);
    const reason = new DOMException("drain timeout", "AbortError");

    controller.abort(reason);
    await expect(queued).rejects.toBe(reason);
    release();
    await first;
    await expect(limiter.run(async () => "next")).resolves.toBe("next");
    expect(ran).not.toHaveBeenCalled();
  });

  it("frees a failed request's slot for the next one", async () => {
    // Break caught: a request that throws keeping its slot, so every upstream
    // failure permanently narrows the client until it admits nothing.
    const limiter = createRequestLimiter({
      maxConcurrent: 1,
      maxPerSecond: 20
    });

    await expect(
      limiter.run(async () => {
        throw new Error("upstream");
      })
    ).rejects.toThrow("upstream");
    await expect(limiter.run(async () => "next")).resolves.toBe("next");
  });

  it("frees an acquired slot once however often it is released", async () => {
    // Break caught: a double release opening a second slot that was never
    // taken, letting more than the limit into flight.
    const limiter = createRequestLimiter({
      maxConcurrent: 1,
      maxPerSecond: 20
    });
    const release = await limiter.acquire();
    release();
    release();

    const held = await limiter.acquire();
    let admitted = false;
    const waiting = limiter.acquire().then((next) => {
      admitted = true;
      return next;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(admitted).toBe(false);

    held();
    (await waiting)();
    expect(admitted).toBe(true);
  });

  it("rejects limits that would admit nothing", () => {
    expect(() =>
      createRequestLimiter({ maxConcurrent: 0, maxPerSecond: 20 })
    ).toThrow("blizzard_max_concurrent_invalid");
    expect(() =>
      createRequestLimiter({ maxConcurrent: 6, maxPerSecond: 0.5 })
    ).toThrow("blizzard_max_per_second_invalid");
  });
});

describe("a Blizzard client with request limits", () => {
  it("hands a caller its wait for a slot, apart from the request itself", async () => {
    // Break caught: time queued behind other callers of the shared client
    // reaching a caller's timing as if it were Blizzard's latency.
    let release!: () => void;
    const fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/token")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      await new Promise<void>((resolve) => (release = resolve));
      return Response.json({ achievements: [] });
    }) as typeof globalThis.fetch;
    const client = createBlizzardClient({
      fetch,
      clientId: "id",
      clientSecret: "secret",
      requestLimits: { maxConcurrent: 1, maxPerSecond: 20 }
    });
    const key: CharacterKey = {
      region: "eu",
      realm: "silvermoon",
      name: "first"
    };
    const waits: number[] = [];
    const waitForSlot = async <R>(wait: () => Promise<R>): Promise<R> => {
      const queuedAt = Date.now();
      const slot = await wait();
      waits.push(Date.now() - queuedAt);
      return slot;
    };

    const first = client.getCompletedAchievements(
      key,
      undefined,
      undefined,
      waitForSlot
    );
    await vi.advanceTimersByTimeAsync(0);
    const second = client.getCompletedAchievements(
      { ...key, name: "second" },
      undefined,
      undefined,
      waitForSlot
    );
    await vi.advanceTimersByTimeAsync(300);
    release();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    release();
    await second;

    expect(waits).toEqual([0, 300]);
  });

  it("holds a concurrent sweep and an evidence run sharing it to 6 in flight and 20 a second", async () => {
    // Break caught: limits applied per caller, or inside the sweep loop, so a
    // sweep and an evidence run on the same credentials could together exceed
    // what Blizzard allows the client; or reads that stay serial.
    const root: CharacterKey = {
      region: "eu",
      realm: "silvermoon",
      name: "root"
    };
    const members = Array.from(
      { length: 40 },
      (_, index) =>
        `member${String.fromCharCode(97 + (index % 26))}${index >= 26 ? "x" : ""}`
    );
    const achievements = {
      achievements: Array.from({ length: 250 }, (_, id) => ({
        id: id + 1,
        completed_timestamp: 1_700_000_000_000 + id
      }))
    };
    const starts: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/token") {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      starts.push(Date.now());
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Answers faster than the measured mean, so only the rate limit, not
      // latency, keeps the client under 20 a second.
      await new Promise((resolve) => setTimeout(resolve, 50));
      inFlight -= 1;
      if (url.pathname.endsWith("/character/silvermoon/root")) {
        return Response.json({
          guild: { name: "A Guild", realm: { slug: "silvermoon" } }
        });
      }
      if (url.pathname === "/data/wow/playable-class/index") {
        return Response.json({ classes: [{ id: 8, name: "Mage" }] });
      }
      if (url.pathname.endsWith("/roster")) {
        return Response.json({
          members: members.map((name) => ({
            character: {
              name,
              realm: { slug: "silvermoon" },
              playable_class: { id: 8 },
              level: 80
            }
          }))
        });
      }
      return Response.json(achievements);
    }) as typeof globalThis.fetch;
    const client = createBlizzardClient({
      fetch,
      clientId: "id",
      clientSecret: "secret",
      requestLimits: { maxConcurrent: 6, maxPerSecond: 20 }
    });

    const sweep = discoverFingerprintMatches(root, client, {
      requestCap: 1_000,
      minimumCommon: 200,
      minimumIdenticalPercent: 20,
      isSuppressed: async () => false,
      // Offers more reads than the client allows, so the client is what holds
      // the line.
      readConcurrency: 16
    });
    const evidence = Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        client.getCompletedAchievements({
          ...root,
          name: `applicant${String.fromCharCode(97 + index)}`
        })
      )
    );
    const all = Promise.all([sweep, evidence]);
    await runUntilSettled(all);

    const [outcome] = await all;
    expect(outcome).toMatchObject({ kind: "matched" });
    expect(outcome.kind === "matched" && outcome.characters).toHaveLength(40);
    // 3 roster reads, the root, 40 members and 10 evidence reads.
    expect(starts).toHaveLength(54);
    expect(peak).toBeLessThanOrEqual(6);
    expect(busiestSecond(starts)).toBeLessThanOrEqual(20);
    // Concurrent, not serial: 54 reads at 50 ms each would take 2.7 s one at
    // a time, and the rate limit alone lets them finish inside 3 s.
    expect(peak).toBeGreaterThan(1);
    expect(Math.max(...starts)).toBeLessThan(3_000);
  });
});
