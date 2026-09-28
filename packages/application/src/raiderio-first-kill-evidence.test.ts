import type {
  PublishedRaiderIoLoggedEncounter,
  StoredCharacterRaiderIoFirstKill
} from "@slashwho/database";
import { describe, expect, it } from "vitest";

import { dossierRaiderIoFirstKill } from "./raiderio-first-kill-evidence";

// Synthetic identities throughout: this repository is public.
const character = {
  region: "eu" as const,
  realm: "draenor",
  name: "alfa"
};
const killGuild = {
  name: "Fixture Guild Alfa",
  realm: "twisting-nether",
  region: "eu"
};
const encounter: PublishedRaiderIoLoggedEncounter = {
  loggedEncounterId: 700_001,
  raidSlug: "tier-mn-1",
  bossSlug: "midnight-falls",
  pulledAt: "2026-07-20T17:17:29.977Z",
  defeatedAt: "2026-07-20T17:25:57.301Z",
  durationMs: 507_324,
  guild: killGuild,
  itemLevel: { average: 290.312, min: 284.938, max: 293.062 },
  deathCount: 2,
  vantusCount: 16,
  shareRaidUntil: null,
  rosterState: "available",
  members: [
    {
      raiderIoCharacterId: 424_242,
      name: "Alfa",
      realm: "draenor",
      region: "eu",
      className: "Demon Hunter",
      specName: "Havoc",
      role: "dps",
      itemLevel: 290.5
    }
  ],
  roleCounts: { tank: 2, healer: 4, dps: 14 },
  readAt: "2026-09-28T12:00:00.000Z"
};
function stored(
  overrides: Partial<StoredCharacterRaiderIoFirstKill> = {}
): StoredCharacterRaiderIoFirstKill {
  return {
    raidSlug: "tier-mn-1",
    bossSlug: "midnight-falls",
    killedAt: "2026-07-20T17:25:57.301Z",
    guild: killGuild,
    loggedEncounterId: 700_001,
    encounterState: "read",
    encounterLimitationCode: null,
    historicWorldRank: null,
    historicRankCheckedAt: "2026-09-28T12:00:00.000Z",
    encounter,
    ...overrides
  };
}

describe("dossierRaiderIoFirstKill", () => {
  it("attributes a read kill to the character, keeps Raider.IO's counts, and drops every Raider.IO id", () => {
    const kill = dossierRaiderIoFirstKill(stored(), character);
    expect(kill).toEqual({
      character,
      raidSlug: "tier-mn-1",
      bossSlug: "midnight-falls",
      killedAt: "2026-07-20T17:25:57.301Z",
      guild: killGuild,
      historicWorldRank: null,
      encounter: {
        state: "read",
        encounter: {
          pulledAt: "2026-07-20T17:17:29.977Z",
          defeatedAt: "2026-07-20T17:25:57.301Z",
          durationMs: 507_324,
          guild: killGuild,
          itemLevel: { average: 290.312, min: 284.938, max: 293.062 },
          deathCount: 2,
          vantusCount: 16,
          roster: {
            state: "available",
            roleCounts: { tank: 2, healer: 4, dps: 14 },
            members: [
              {
                name: "Alfa",
                realm: "draenor",
                region: "eu",
                className: "Demon Hunter",
                specName: "Havoc",
                role: "dps",
                itemLevel: 290.5
              }
            ]
          }
        }
      }
    });
    expect(JSON.stringify(kill)).not.toContain("424242");
    expect(JSON.stringify(kill)).not.toContain("700001");
  });

  it.each([
    [
      "no logged encounter",
      stored({
        loggedEncounterId: null,
        encounterState: "unavailable",
        encounter: null
      }),
      "none"
    ],
    [
      "a read not yet made",
      stored({
        encounterState: "unavailable",
        encounterLimitationCode: "request_cap",
        encounter: null
      }),
      "not_read"
    ],
    [
      "a log Raider.IO no longer has",
      stored({
        encounterState: "unavailable",
        encounterLimitationCode: "not_found",
        encounter: null
      }),
      "none"
    ],
    [
      "a log Raider.IO refuses to show",
      stored({
        encounterState: "unavailable",
        encounterLimitationCode: "private",
        encounter: null
      }),
      "none"
    ],
    [
      "a log of another kill",
      stored({
        encounterState: "unavailable",
        encounterLimitationCode: "schema_drift",
        encounter: null
      }),
      "none"
    ],
    [
      "a read row whose encounter is missing",
      stored({ encounter: null }),
      "not_read"
    ]
  ])("maps %s", (_name, kill, state) => {
    // Break caught (#734 pre-flight): a 403 is as permanent as a 404, and
    // mapped to "not read yet" it promised a roster that never comes.
    expect(dossierRaiderIoFirstKill(kill, character).encounter.state).toBe(
      state
    );
  });

  it("drops a guild in a region the dossier cannot name rather than failing the read", () => {
    const kill = dossierRaiderIoFirstKill(
      stored({
        guild: { name: "Guild", realm: "realm", region: "cn" },
        encounter: {
          ...encounter,
          guild: { name: "Guild", realm: "realm", region: "cn" }
        }
      }),
      character
    );
    expect(kill.guild).toBeNull();
    expect(
      kill.encounter.state === "read" && kill.encounter.encounter.guild
    ).toBeNull();
  });

  it("hands a roster the guild hid over as private", () => {
    const hidden = dossierRaiderIoFirstKill(
      stored({
        encounter: {
          ...encounter,
          rosterState: "private",
          members: [],
          roleCounts: { tank: 0, healer: 0, dps: 0 }
        }
      }),
      character
    );
    expect(
      hidden.encounter.state === "read" && hidden.encounter.encounter.roster
    ).toEqual({ state: "private" });
  });
});
