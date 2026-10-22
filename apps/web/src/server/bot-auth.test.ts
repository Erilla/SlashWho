import { applicationConfigSchema } from "@slashwho/application";
import { describe, expect, it } from "vitest";

import { requireBot } from "./bot-auth";

const config = applicationConfigSchema.parse({
  BOT_API_KEY: "b".repeat(32),
  RATE_LIMIT_HASH_SECRET: "r".repeat(32)
});

describe("requireBot", () => {
  it("accepts a valid bearer key as the bot", () => {
    const result = requireBot(
      new Headers({ authorization: `Bearer ${"b".repeat(32)}` }),
      config
    );
    expect(result).toMatchObject({
      identity: { callerClass: "bot" }
    });
  });

  it("refuses a missing key with 401, never the anonymous path", () => {
    const result = requireBot(
      new Headers({ "x-real-ip": "203.0.113.8" }),
      config
    );
    expect("refusal" in result && result.refusal.status).toBe(401);
  });

  it("refuses a wrong key with 401", () => {
    const result = requireBot(
      new Headers({ authorization: `Bearer ${"w".repeat(32)}` }),
      config
    );
    expect("refusal" in result && result.refusal.status).toBe(401);
  });
});
