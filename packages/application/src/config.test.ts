import { describe, expect, it } from "vitest";

import { applicationConfigSchema } from "./config";

const required = {
  BOT_API_KEY: "b".repeat(32),
  RATE_LIMIT_HASH_SECRET: "r".repeat(32)
};

describe("dossier application configuration", () => {
  it("applies bounded dossier defaults", () => {
    // Break caught: omitted deployment configuration could allow an unbounded
    // roster per dossier -- or, as the old default of 12 did, hide real
    // characters from the reviewer (#555).
    expect(applicationConfigSchema.parse(required)).toMatchObject({
      DOSSIER_CHARACTER_CEILING: 50
    });
  });

  it("no longer applies the retired character cap", () => {
    // Break caught (#555): Railway still sets DOSSIER_CHARACTER_CAP=12. Were it
    // read, removing the cap in code would change nothing in production.
    const config = applicationConfigSchema.parse({
      ...required,
      DOSSIER_CHARACTER_CAP: "12"
    });
    expect(config.DOSSIER_CHARACTER_CEILING).toBe(50);
    expect(config).not.toHaveProperty("DOSSIER_CHARACTER_CAP");
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
    ["DOSSIER_CHARACTER_CEILING", 0],
    ["DOSSIER_CHARACTER_CEILING", 51]
  ])("rejects invalid %s values", (name, value) => {
    // Break caught: a malformed cap could cause a request to exceed its intended upstream bound.
    expect(() =>
      applicationConfigSchema.parse({ ...required, [name]: value })
    ).toThrow();
  });
});
