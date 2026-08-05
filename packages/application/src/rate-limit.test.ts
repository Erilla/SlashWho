import type { RateLimitRepository } from "@slashwho/database";
import { describe, expect, it } from "vitest";

import { applicationConfigSchema } from "./config";
import { createRateLimiter } from "./rate-limit";

const config = applicationConfigSchema.parse({
  BOT_API_KEY: "bot-secret-that-is-at-least-32-characters",
  RATE_LIMIT_HASH_SECRET: "rate-secret-that-is-at-least-32-characters"
});
const now = new Date("2026-08-04T12:00:00.000Z");

function fakeRepository(decision: { allowed: boolean; retryAt: Date | null }) {
  const calls: Parameters<RateLimitRepository["reserve"]>[] = [];
  const repository: RateLimitRepository = {
    async reserve(...args) {
      calls.push(args);
      return decision;
    },
    async record() {},
    async countActive() {
      return 0;
    },
    async cleanupExpired() {
      return 0;
    }
  };
  return { repository, calls };
}

describe("rate limiting policy", () => {
  it("uses independent bot and anonymous search allowances", () => {
    // Break caught: bot traffic could accidentally inherit the anonymous capacity.
    const { repository } = fakeRepository({ allowed: true, retryAt: null });
    const limiter = createRateLimiter({ repository, config, now: () => now });

    expect(
      limiter.searchReservation({ callerClass: "anonymous", bucketHash: "a" })
    ).toMatchObject({ bucketHash: "search:a", limit: 10 });
    expect(
      limiter.searchReservation({ callerClass: "bot", bucketHash: "b" })
    ).toMatchObject({ bucketHash: "search:b", limit: 60 });
  });

  it("reserves cached reads in a separate one-minute bucket", async () => {
    // Break caught: serving a cached result could consume scarce search-job allowance.
    const fake = fakeRepository({ allowed: true, retryAt: null });
    const limiter = createRateLimiter({
      repository: fake.repository,
      config,
      now: () => now
    });

    await expect(
      limiter.reservePublicRead({
        callerClass: "anonymous",
        bucketHash: "private-hmac"
      })
    ).resolves.toEqual({ allowed: true, retryAfterSeconds: null });
    expect(fake.calls).toEqual([
      ["read:private-hmac", 300, new Date("2026-08-04T12:01:00.000Z"), now]
    ]);
  });

  it("returns a whole-second Retry-After when a bucket is exhausted", async () => {
    // Break caught: clients could retry before the oldest active event expires.
    const fake = fakeRepository({
      allowed: false,
      retryAt: new Date("2026-08-04T12:00:01.001Z")
    });
    const limiter = createRateLimiter({
      repository: fake.repository,
      config,
      now: () => now
    });

    await expect(
      limiter.reservePublicRead({ callerClass: "bot", bucketHash: "bot-hmac" })
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 2 });
  });
});
