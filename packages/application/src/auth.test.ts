import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { applicationConfigSchema } from "./config";
import {
  AuthenticationError,
  classifyCaller,
  railwayClientIpHeader
} from "./auth";

const botApiKey = "bot-secret-that-is-at-least-32-characters";
const hashSecret = "rate-secret-that-is-at-least-32-characters";
const config = applicationConfigSchema.parse({
  BOT_API_KEY: botApiKey,
  RATE_LIMIT_HASH_SECRET: hashSecret
});

function headers(values: Record<string, string> = {}): Headers {
  return new Headers(values);
}

describe("application configuration", () => {
  it("applies the documented policy defaults", () => {
    // Break caught: a deployment with only secrets could silently get a different abuse policy.
    expect(config).toMatchObject({
      ANONYMOUS_SEARCHES_PER_HOUR: 10,
      BOT_SEARCHES_PER_HOUR: 60,
      PUBLIC_READS_PER_MINUTE: 300,
      FRESHNESS_HOURS: 24
    });
    expect(config).not.toHaveProperty("NEGATIVE_CACHE_MINUTES");
    expect(config).not.toHaveProperty("DISCOVERY_REQUEST_CAP");
  });

  it("rejects short secrets and non-positive limits", () => {
    // Break caught: guessable secrets or disabled-by-accident limits could reach runtime.
    expect(() =>
      applicationConfigSchema.parse({
        BOT_API_KEY: "short",
        RATE_LIMIT_HASH_SECRET: hashSecret
      })
    ).toThrow();
    expect(() =>
      applicationConfigSchema.parse({
        BOT_API_KEY: botApiKey,
        RATE_LIMIT_HASH_SECRET: hashSecret,
        ANONYMOUS_SEARCHES_PER_HOUR: 0
      })
    ).toThrow();
  });
});

describe("caller classification", () => {
  it("authenticates the configured bot without retaining its raw key", () => {
    // Break caught: bot credentials could be persisted as the rate-limit identity.
    const caller = classifyCaller(
      headers({ authorization: `Bearer ${botApiKey}` }),
      config
    );

    expect(caller.callerClass).toBe("bot");
    expect(caller.bucketHash).toMatch(/^[a-f0-9]{64}$/);
    expect(caller.bucketHash).not.toContain(botApiKey);
  });

  it("rejects an invalid bearer credential instead of downgrading it", () => {
    // Break caught: an invalid bot secret could consume or bypass anonymous policy.
    expect(() =>
      classifyCaller(
        headers({ authorization: `Bearer ${"x".repeat(40)}` }),
        config
      )
    ).toThrow(AuthenticationError);
  });

  it("uses only Railway X-Real-IP for anonymous buckets", () => {
    // Break caught: a forged forwarded chain could choose a fresh anonymous bucket.
    const caller = classifyCaller(
      headers({
        [railwayClientIpHeader]: "203.0.113.8",
        "x-forwarded-for": "198.51.100.2"
      }),
      config
    );
    const expected = createHmac("sha256", hashSecret)
      .update("anonymous:203.0.113.8")
      .digest("hex");

    expect(caller).toEqual({
      callerClass: "anonymous",
      bucketHash: expected
    });
    expect(caller.bucketHash).not.toContain("203.0.113.8");
  });

  it("fails closed when Railway did not supply a client IP", () => {
    // Break caught: direct or misconfigured traffic could collapse into one anonymous bucket.
    expect(() =>
      classifyCaller(headers({ "x-forwarded-for": "198.51.100.2" }), config)
    ).toThrow(AuthenticationError);
  });
});
