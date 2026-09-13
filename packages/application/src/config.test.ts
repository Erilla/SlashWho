import { describe, expect, it } from "vitest";

import { applicationConfigSchema } from "./config";

const required = {
  BOT_API_KEY: "b".repeat(32),
  RATE_LIMIT_HASH_SECRET: "r".repeat(32)
};

describe("dossier application configuration", () => {
  it("applies bounded dossier defaults", () => {
    // Break caught: omitted deployment configuration could permit unbounded evidence gathering.
    expect(applicationConfigSchema.parse(required)).toMatchObject({
      DOSSIER_CHARACTER_CAP: 12,
      DOSSIER_WARCRAFT_LOGS_REQUEST_CAP: 80,
      DOSSIER_WARCRAFT_LOGS_TIMEOUT_MS: 15_000,
      DOSSIER_INITIAL_WARCRAFT_LOGS_REQUEST_CAP: 20,
      DOSSIER_INITIAL_WARCRAFT_LOGS_TIMEOUT_MS: 8_000
    });
  });

  it.each([
    ["DOSSIER_CHARACTER_CAP", 0],
    ["DOSSIER_CHARACTER_CAP", 31],
    ["DOSSIER_WARCRAFT_LOGS_REQUEST_CAP", 0],
    ["DOSSIER_WARCRAFT_LOGS_REQUEST_CAP", 201],
    ["DOSSIER_WARCRAFT_LOGS_TIMEOUT_MS", 999],
    ["DOSSIER_WARCRAFT_LOGS_TIMEOUT_MS", 60_001],
    ["DOSSIER_INITIAL_WARCRAFT_LOGS_REQUEST_CAP", 0],
    ["DOSSIER_INITIAL_WARCRAFT_LOGS_REQUEST_CAP", 201],
    ["DOSSIER_INITIAL_WARCRAFT_LOGS_TIMEOUT_MS", 999],
    ["DOSSIER_INITIAL_WARCRAFT_LOGS_TIMEOUT_MS", 60_001]
  ])("rejects invalid %s values", (name, value) => {
    // Break caught: a malformed cap could cause a request to exceed its intended upstream bound.
    expect(() =>
      applicationConfigSchema.parse({ ...required, [name]: value })
    ).toThrow();
  });
});
