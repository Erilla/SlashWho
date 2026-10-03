import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { createRosterProfileResolutionRepository } from "./roster-profile-resolutions";

describe("roster resolution input boundary", () => {
  // An unconnected pool proves malformed upstream locators cannot reach SQL.
  const repository = createRosterProfileResolutionRepository(new Pool());
  it("rejects invalid locators before database admission", async () => {
    await expect(
      repository.reserve(
        { region: "eu", realm: "draenor", name: "alfa-123", historicId: 456 },
        new Date()
      )
    ).rejects.toThrow("invalid_roster_profile_locator");
  });
  it("rejects unsafe IDs before answer persistence", async () => {
    await expect(
      repository.answer(
        { region: "eu", realm: "draenor", name: "alfa-123", historicId: 123 },
        "token",
        { resolvedId: Number.MAX_SAFE_INTEGER + 1, limitationCode: null },
        new Date()
      )
    ).rejects.toThrow("invalid_roster_profile_answer");
  });
});
