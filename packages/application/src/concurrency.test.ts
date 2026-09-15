import { describe, expect, it } from "vitest";

import { createConcurrencyLimiter } from "./concurrency";

describe("createConcurrencyLimiter", () => {
  it("runs no more than the configured number of jobs at once", async () => {
    const limiter = createConcurrencyLimiter(2);
    let active = 0;
    let maximum = 0;

    const jobs = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        limiter.run(
          () =>
            new Promise<number>((resolve) => {
              active += 1;
              maximum = Math.max(maximum, active);
              setTimeout(() => {
                active -= 1;
                resolve(index);
              }, 1);
            })
        )
      )
    );

    expect(jobs).toEqual([0, 1, 2, 3, 4]);
    expect(maximum).toBe(2);
  });

  it("reports admission wait without including the work", async () => {
    const waits: number[] = [];
    let clock = 0;
    const limiter = createConcurrencyLimiter(1, {
      onWait: (ms) => waits.push(ms),
      monotonic: () => clock
    });

    let releaseFirst: (() => void) | undefined;
    const first = limiter.run(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        })
    );

    const second = limiter.run(async () => {
      clock += 100;
    });

    clock = 30;
    await Promise.resolve(); // flush microtasks so work function starts
    releaseFirst!();
    await Promise.all([first, second]);

    expect(waits).toEqual([0, 30]);
  });

  it("reports a zero wait when admission is immediate", async () => {
    const waits: number[] = [];
    const limiter = createConcurrencyLimiter(2, {
      onWait: (ms) => waits.push(ms),
      monotonic: () => 0
    });

    await Promise.all([
      limiter.run(async () => undefined),
      limiter.run(async () => undefined)
    ]);

    expect(waits).toEqual([0, 0]);
  });

  it("works without an onWait callback", async () => {
    const limiter = createConcurrencyLimiter(1);
    await expect(limiter.run(async () => "ok")).resolves.toBe("ok");
  });

  it("recovers from synchronous throws without deadlock", async () => {
    const limiter = createConcurrencyLimiter(1);

    // Queue a job that throws synchronously
    const throwingJob = limiter.run(() => {
      throw new Error("sync throw");
    });

    // Queue a second job after the throwing one
    const followingJob = limiter.run(async () => "ok");

    // First job should reject
    await expect(throwingJob).rejects.toThrow("sync throw");

    // Second job should still settle (no deadlock)
    await expect(followingJob).resolves.toBe("ok");
  });
});
