import { describe, expect, it } from "vitest";

import type {
  CharacterMythicKillPerformance,
  CharacterRaiderIoFirstKillInput,
  CharacterTierBestParseInput,
  StoredCharacterMythicKill,
  StoredCharacterMythicWipe
} from "../repositories";
import {
  type EvidencePublishInput,
  type StoredEvidenceForMerge,
  mergePublishedEvidence,
  mergeRaiderIoFirstKills
} from "./merge";

const earlier = new Date("2026-09-01T00:00:00.000Z");
const completedAt = new Date("2026-09-20T00:00:00.000Z");

const unavailable = { state: "unavailable" } as const;

function performance(
  damage: CharacterMythicKillPerformance["damage"] = unavailable
): CharacterMythicKillPerformance {
  return {
    spec: null,
    damage,
    healing: { state: "not_applicable" },
    bossDamage: unavailable
  };
}

function kill(
  fightUrl: string,
  overrides: Partial<StoredCharacterMythicKill> = {}
): StoredCharacterMythicKill {
  return {
    id: `id-${fightUrl}`,
    raidId: "raid-current",
    raidName: "Current Raid",
    bossId: "boss-1",
    bossName: "First Boss",
    journalBossId: null,
    bossOrder: 1,
    killedAt: "2026-08-30T20:00:00.000Z",
    reportUrl: `https://www.warcraftlogs.com/reports/${fightUrl}`,
    fightUrl,
    guild: null,
    performance: performance(),
    parsesReadAt: null,
    ...overrides
  };
}

function wipe(
  fightUrl: string,
  raidId = "raid-current"
): StoredCharacterMythicWipe {
  return {
    id: `id-${fightUrl}`,
    raidId,
    raidName: "Current Raid",
    bossId: "boss-1",
    bossName: "First Boss",
    journalBossId: null,
    bossOrder: 1,
    attemptedAt: "2026-08-30T19:00:00.000Z",
    reportUrl: `https://www.warcraftlogs.com/reports/${fightUrl}`,
    fightUrl
  };
}

function tierBest(
  raidId: string,
  damage: CharacterMythicKillPerformance["damage"] = unavailable
): CharacterTierBestParseInput {
  return {
    raidId,
    raidName: raidId,
    bossId: "boss-1",
    bossName: "First Boss",
    rankingsUrl: `https://www.warcraftlogs.com/character/rankings/${raidId}`,
    performance: performance(damage)
  };
}

function stored(
  overrides: Partial<StoredEvidenceForMerge> = {}
): StoredEvidenceForMerge {
  return {
    positive: { kills: [], wipes: [] },
    tierSearchKills: [],
    terminalKillRaidIds: new Set(),
    performanceByFightUrl: new Map(),
    collectedAtByFightUrl: new Map(),
    parsesReadAtByFightUrl: new Map(),
    historicRankByFightUrl: new Map(),
    tierBests: new Map(),
    ...overrides
  };
}

function input(
  overrides: Partial<EvidencePublishInput> = {}
): EvidencePublishInput {
  return {
    state: "complete",
    completedAt,
    kills: [],
    wipes: [],
    tierBests: [],
    ...overrides
  };
}

const fightUrls = (kills: readonly { kill: { fightUrl: string } }[]) =>
  kills.map(({ kill }) => kill.fightUrl).sort();

describe("mergePublishedEvidence carry-forward", () => {
  it("keeps every stored kill and wipe through a partial publish", () => {
    const merged = mergePublishedEvidence(
      stored({
        positive: { kills: [kill("stored")], wipes: [wipe("stored-wipe")] }
      }),
      input({ state: "partial", kills: [kill("new")] }),
      false
    );

    expect(fightUrls(merged.kills)).toEqual(["new", "stored"]);
    expect(merged.wipes.map((row) => row.fightUrl)).toEqual(["stored-wipe"]);
  });

  it("drops a kill a complete run stopped finding in a raid still being read", () => {
    const merged = mergePublishedEvidence(
      stored({
        positive: { kills: [kill("gone")], wipes: [wipe("gone-wipe")] }
      }),
      input({ kills: [kill("found")] }),
      false
    );

    expect(fightUrls(merged.kills)).toEqual(["found"]);
    expect(merged.wipes).toEqual([]);
  });

  it("keeps a terminal raid's kills and tier-search kills through a complete publish", () => {
    const merged = mergePublishedEvidence(
      stored({
        positive: {
          kills: [kill("terminal", { raidId: "raid-old" }), kill("gone")],
          wipes: [wipe("terminal-wipe", "raid-old"), wipe("gone-wipe")]
        },
        tierSearchKills: [kill("searched", { raidId: "raid-searched" })],
        terminalKillRaidIds: new Set(["raid-old"])
      }),
      input(),
      false
    );

    expect(fightUrls(merged.kills)).toEqual(["searched", "terminal"]);
    expect(merged.wipes.map((row) => row.fightUrl)).toEqual(["terminal-wipe"]);
  });

  it("treats a targeted tier search as additive even when complete", () => {
    const merged = mergePublishedEvidence(
      stored({ positive: { kills: [kill("stored")], wipes: [] } }),
      input({ kills: [kill("searched")] }),
      true
    );

    expect(fightUrls(merged.kills)).toEqual(["searched", "stored"]);
  });
});

describe("mergePublishedEvidence parses", () => {
  it("keeps a stored parse when a partial run re-finds the kill without one", () => {
    const merged = mergePublishedEvidence(
      stored({
        positive: {
          kills: [
            kill("fight", {
              performance: performance({ state: "available", percentile: 87 })
            })
          ],
          wipes: []
        }
      }),
      input({ state: "partial", kills: [kill("fight")] }),
      false
    );

    expect(merged.kills).toHaveLength(1);
    expect(merged.kills[0]!.performance.damage).toEqual({
      state: "available",
      percentile: 87
    });
  });

  it("keeps a stored parse for a re-found kill a complete run did not carry", () => {
    const merged = mergePublishedEvidence(
      stored({
        performanceByFightUrl: new Map([
          [
            "fight",
            {
              spec: null,
              damage: { state: "available", percentile: 42 },
              healing: { state: "not_applicable", percentile: null },
              bossDamage: { state: "unavailable", percentile: null }
            }
          ]
        ])
      }),
      input({ kills: [kill("fight")] }),
      false
    );

    expect(merged.kills[0]!.performance.damage).toEqual({
      state: "available",
      percentile: 42
    });
  });

  it("keeps an available zero, unavailable and not_applicable distinct", () => {
    const merged = mergePublishedEvidence(
      stored(),
      input({
        kills: [
          kill("fight", {
            performance: performance({ state: "available", percentile: 0 })
          })
        ]
      }),
      false
    );

    expect(merged.kills[0]!.performance).toEqual({
      spec: null,
      damage: { state: "available", percentile: 0 },
      healing: { state: "not_applicable", percentile: null },
      bossDamage: { state: "unavailable", percentile: null }
    });
  });

  it("replaces a stored parse with a newer available one", () => {
    const merged = mergePublishedEvidence(
      stored({
        positive: {
          kills: [
            kill("fight", {
              performance: performance({ state: "available", percentile: 50 })
            })
          ],
          wipes: []
        }
      }),
      input({
        state: "partial",
        kills: [
          kill("fight", {
            performance: performance({ state: "available", percentile: 0 })
          })
        ]
      }),
      false
    );

    expect(merged.kills[0]!.performance.damage).toEqual({
      state: "available",
      percentile: 0
    });
  });
});

describe("mergePublishedEvidence timestamps", () => {
  it("stamps a re-found fight and keeps a carried fight's collected_at", () => {
    const merged = mergePublishedEvidence(
      stored({
        positive: { kills: [kill("carried"), kill("found")], wipes: [] },
        collectedAtByFightUrl: new Map([
          ["carried", earlier],
          ["found", earlier]
        ])
      }),
      input({ state: "partial", kills: [kill("found")] }),
      false
    );

    const byUrl = new Map(merged.kills.map((row) => [row.kill.fightUrl, row]));
    expect(byUrl.get("carried")!.collectedAt).toBe(earlier);
    expect(byUrl.get("found")!.collectedAt).toBe(completedAt);
  });

  it("restamps parses_read_at only for fights the run asked about", () => {
    const merged = mergePublishedEvidence(
      stored({
        positive: {
          kills: [kill("asked"), kill("answered"), kill("never")],
          wipes: []
        },
        parsesReadAtByFightUrl: new Map([["answered", earlier]])
      }),
      input({
        state: "partial",
        kills: [kill("asked"), kill("answered")],
        parsedFightUrls: ["asked"]
      }),
      false
    );

    const byUrl = new Map(merged.kills.map((row) => [row.kill.fightUrl, row]));
    expect(byUrl.get("asked")!.parsesReadAt).toBe(completedAt);
    expect(byUrl.get("answered")!.parsesReadAt).toBe(earlier);
    expect(byUrl.get("never")!.parsesReadAt).toBeNull();
  });

  it("does not let a targeted search mark a fight it left out as read", () => {
    const merged = mergePublishedEvidence(
      stored({ positive: { kills: [kill("other-raid")], wipes: [] } }),
      input({
        kills: [kill("searched")],
        parsedFightUrls: ["searched", "other-raid"]
      }),
      true
    );

    const byUrl = new Map(merged.kills.map((row) => [row.kill.fightUrl, row]));
    expect(byUrl.get("searched")!.parsesReadAt).toBe(completedAt);
    expect(byUrl.get("other-raid")!.parsesReadAt).toBeNull();
  });

  it("carries a stored historic rank lookup when the run supplies none", () => {
    const merged = mergePublishedEvidence(
      stored({
        historicRankByFightUrl: new Map([
          ["fight", { historicWorldRank: 12, historicRankCheckedAt: earlier }]
        ])
      }),
      input({ kills: [kill("fight")] }),
      false
    );

    expect(merged.kills[0]).toMatchObject({
      historicWorldRank: 12,
      historicRankCheckedAt: earlier
    });
  });

  it("keeps an unread zone's tier best and read time, and restamps a read one", () => {
    const storedTierBest = (raidId: string, percentile: number) => ({
      tierBest: tierBest(raidId),
      performance: {
        spec: null,
        damage: { state: "available" as const, percentile },
        healing: { state: "not_applicable" as const, percentile: null },
        bossDamage: { state: "unavailable" as const, percentile: null }
      },
      collectedAt: earlier
    });
    const merged = mergePublishedEvidence(
      stored({
        tierBests: new Map([
          ["raid-old\0boss-1", storedTierBest("raid-old", 70)],
          ["raid-current\0boss-1", storedTierBest("raid-current", 60)]
        ])
      }),
      input({ state: "partial", tierBests: [tierBest("raid-current")] }),
      false
    );

    const byRaid = new Map(
      merged.tierBests.map((row) => [row.tierBest.raidId, row])
    );
    expect(byRaid.get("raid-old")).toMatchObject({ collectedAt: earlier });
    expect(byRaid.get("raid-old")!.performance.damage.percentile).toBe(70);
    // The run read the zone but found no parse, so the stored one stands.
    expect(byRaid.get("raid-current")).toMatchObject({
      collectedAt: completedAt
    });
    expect(byRaid.get("raid-current")!.performance.damage).toEqual({
      state: "available",
      percentile: 60
    });
  });
});

describe("mergeRaiderIoFirstKills", () => {
  function firstKill(
    raidSlug: string,
    bossSlug: string,
    overrides: Partial<CharacterRaiderIoFirstKillInput> = {}
  ): CharacterRaiderIoFirstKillInput {
    return {
      raidSlug,
      bossSlug,
      killedAt: "2026-07-20T17:25:57.301Z",
      guild: {
        name: "Fixture Guild Alfa",
        realm: "twisting-nether",
        region: "eu"
      },
      loggedEncounterId: 700_001,
      encounterState: "read",
      encounterLimitationCode: null,
      historicWorldRank: null,
      historicRankCheckedAt: null,
      ...overrides
    };
  }
  const midnightFalls = firstKill("tier-mn-1", "midnight-falls");
  const queenAnsurek = firstKill("nerubar-palace", "queen-ansurek", {
    killedAt: "2024-10-01T20:00:00.000Z",
    loggedEncounterId: 1_234
  });
  const stored = [midnightFalls, queenAnsurek];
  const bosses = (kills: readonly CharacterRaiderIoFirstKillInput[]) =>
    kills.map((kill) => kill.bossSlug);

  it("carries every stored kill forward when the run did not read Raider.IO", () => {
    expect(
      bosses(mergeRaiderIoFirstKills(stored, undefined, "complete", false))
    ).toEqual(["queen-ansurek", "midnight-falls"]);
  });

  it.each([
    ["partial", "partial" as const, false],
    ["targeted", "complete" as const, true]
  ])(
    "carries every stored kill forward on a %s publish",
    (_name, state, targeted) => {
      expect(
        bosses(
          mergeRaiderIoFirstKills(
            stored,
            { kills: [], askedRaidSlugs: ["tier-mn-1"], limitationCode: null },
            state,
            targeted
          )
        )
      ).toEqual(["queen-ansurek", "midnight-falls"]);
    }
  );

  it("keeps on a complete publish what the run found again, and every raid it did not ask about", () => {
    // Break caught: a complete publish dropping first kills of raids whose
    // tiers the run deliberately skipped, as #592 once did to stored kills.
    expect(
      bosses(
        mergeRaiderIoFirstKills(
          stored,
          { kills: [], askedRaidSlugs: ["tier-mn-1"], limitationCode: null },
          "complete",
          false
        )
      )
    ).toEqual(["queen-ansurek"]);
  });

  it("never loses a read encounter to a later failed read", () => {
    const merged = mergeRaiderIoFirstKills(
      stored,
      {
        kills: [
          firstKill("tier-mn-1", "midnight-falls", {
            killedAt: "2026-07-20T17:25:57.000Z",
            encounterState: "unavailable",
            encounterLimitationCode: "rate_limited"
          })
        ],
        askedRaidSlugs: ["tier-mn-1"],
        limitationCode: "rate_limited"
      },
      "partial",
      false
    );
    expect(merged.find((kill) => kill.bossSlug === "midnight-falls")).toEqual(
      midnightFalls
    );
  });

  it("keeps a found world rank when a later lookup has none", () => {
    const merged = mergeRaiderIoFirstKills(
      [
        firstKill("tier-mn-1", "midnight-falls", {
          historicWorldRank: 3,
          historicRankCheckedAt: "2026-09-01T00:00:00.000Z"
        })
      ],
      {
        kills: [midnightFalls],
        askedRaidSlugs: ["tier-mn-1"],
        limitationCode: null
      },
      "complete",
      false
    );
    expect(merged[0]).toMatchObject({
      historicWorldRank: 3,
      historicRankCheckedAt: "2026-09-01T00:00:00.000Z"
    });
  });

  it("never duplicates a boss", () => {
    const merged = mergeRaiderIoFirstKills(
      stored,
      {
        kills: [midnightFalls, queenAnsurek],
        askedRaidSlugs: ["tier-mn-1", "nerubar-palace"],
        limitationCode: null
      },
      "complete",
      false
    );
    expect(bosses(merged)).toEqual(["queen-ansurek", "midnight-falls"]);
  });
});
