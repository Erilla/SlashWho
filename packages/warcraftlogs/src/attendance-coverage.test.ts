import { describe, expect, it } from "vitest";

import { uncoveredVerifiedKills } from "./attendance-coverage";
import type { WarcraftLogsVerifiedKill } from "./types";

describe("uncoveredVerifiedKills", () => {
  const verified = (at: string): WarcraftLogsVerifiedKill => ({
    at,
    guild: { name: "Guild", realm: "realm", region: "eu" }
  });
  const start = Date.parse("2025-04-01T19:00:00.000Z");
  const span = { start, end: start + 3 * 60 * 60 * 1_000 };

  it("leaves a kill inside a scanned report, allowing for clock slack", () => {
    expect(
      uncoveredVerifiedKills([verified("2025-04-01T23:30:00.000Z")], [span])
    ).toEqual([]);
  });

  it("returns a kill no scanned report reaches", () => {
    const wanted = verified("2025-04-08T20:00:00.000Z");
    expect(uncoveredVerifiedKills([wanted], [span])).toEqual([
      { verified: wanted, at: Date.parse(wanted.at) }
    ]);
  });
});
