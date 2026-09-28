import { describe, expect, it } from "vitest";

import { matchesRaiderIoKill, STORED_KILL_MATCH_MS } from "./kill-matching";

describe("matchesRaiderIoKill", () => {
  const midnightFalls = {
    raidSlug: "tier-mn-1",
    bossSlug: "midnight-falls",
    killedAt: "2026-07-20T17:25:57.301Z"
  };

  it("matches stored kills within two hours of Raider.IO's time", () => {
    expect(STORED_KILL_MATCH_MS).toBe(7_200_000);
  });

  it.each([
    ["an hour later", "2026-07-20T18:25:57.301Z", true],
    ["exactly two hours later", "2026-07-20T19:25:57.301Z", true],
    ["two hours and a second later", "2026-07-20T19:25:58.301Z", false],
    ["an hour earlier", "2026-07-20T16:25:57.301Z", true]
  ])("matches a Warcraft Logs kill %s: %s", (_name, killedAt, matches) => {
    expect(
      matchesRaiderIoKill(midnightFalls, {
        raidName: "March on Quel'Danas",
        bossName: "Midnight Falls",
        killedAt
      })
    ).toBe(matches);
  });

  it("matches the boss by Raider.IO's slugs, whatever zone Warcraft Logs filed it under", () => {
    expect(
      matchesRaiderIoKill(midnightFalls, {
        raidName: "VS / DR / MQD",
        bossName: "Midnight Falls",
        killedAt: "2026-07-20T18:00:00.000Z"
      })
    ).toBe(true);
    expect(
      matchesRaiderIoKill(midnightFalls, {
        raidName: "March on Quel'Danas",
        bossName: "Belo'ren, Child of Al'ar",
        killedAt: "2026-07-20T17:25:57.301Z"
      })
    ).toBe(false);
  });

  it("never matches a kill it cannot name", () => {
    expect(
      matchesRaiderIoKill(midnightFalls, {
        raidName: "March on Quel'Danas",
        killedAt: "2026-07-20T17:25:57.301Z"
      })
    ).toBe(false);
  });

  it.each(["Grong, the Jungle Lord", "Grong, the Revenant"])(
    "matches Raider.IO's Grong to either faction's Warcraft Logs kill (%s)",
    (bossName) => {
      expect(
        matchesRaiderIoKill(
          {
            raidSlug: "battle-of-dazaralor",
            bossSlug: "grong",
            killedAt: "2019-02-12T20:00:00.000Z"
          },
          {
            raidName: "Battle of Dazar'alor",
            bossName,
            killedAt: "2019-02-12T20:30:00.000Z"
          }
        )
      ).toBe(true);
    }
  );
});
