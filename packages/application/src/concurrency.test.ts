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
});
