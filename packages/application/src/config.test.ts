import { describe, expect, it } from "vitest";

import { applicationConfigSchema } from "./config";

const required = {
  BOT_API_KEY: "b".repeat(32),
  RATE_LIMIT_HASH_SECRET: "r".repeat(32)
};

describe("dossier application configuration", () => {
  it("applies bounded dossier defaults", () => {
    // Break caught: omitted deployment configuration could allow too many linked characters per dossier.
    expect(applicationConfigSchema.parse(required)).toMatchObject({
      DOSSIER_CHARACTER_CAP: 12
    });
  });

  it("shares the negative-cache TTL with the worker rather than redefining it", () => {
    // Break caught: the read path could remember a failed lookup for a
    // different length of time than the worker does, from a second knob.
    expect(applicationConfigSchema.parse(required)).toMatchObject({
      NEGATIVE_CACHE_TTL_MS: 300_000
    });
    expect(
      applicationConfigSchema.parse({
        ...required,
        NEGATIVE_CACHE_TTL_MS: "60000"
      })
    ).toMatchObject({ NEGATIVE_CACHE_TTL_MS: 60_000 });
    expect(() =>
      applicationConfigSchema.parse({
        ...required,
        NEGATIVE_CACHE_TTL_MS: "0"
      })
    ).toThrow("invalid_negative_cache_ttl");
  });

  it.each([
    ["DOSSIER_CHARACTER_CAP", 0],
    ["DOSSIER_CHARACTER_CAP", 31]
  ])("rejects invalid %s values", (name, value) => {
    // Break caught: a malformed cap could cause a request to exceed its intended upstream bound.
    expect(() =>
      applicationConfigSchema.parse({ ...required, [name]: value })
    ).toThrow();
  });
});
