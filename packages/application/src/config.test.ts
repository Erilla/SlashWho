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
