import { describe, expect, expectTypeOf, it } from "vitest";
import type { CharacterKey } from "./character-key";
import {
  buildApplicantDossier,
  type ApplicantDossierBoss,
  type DossierKillEvidence,
  type DossierTierBestParse,
  type DossierWipeEvidence
} from "./applicant-dossier";
import { lookupRaiderIoBoss } from "./raid-catalogue";

const root: CharacterKey = { region: "eu", realm: "silvermoon", name: "ryii" };
const altKey: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "ryalts"
};
const rootCharacter = { key: root, displayName: "Ryii" };
const altCharacter = { key: altKey, displayName: "Ryalts" };
const usAltKey: CharacterKey = {
  region: "us",
  realm: "illidan",
  name: "ryalts"
};
const usAltCharacter = { key: usAltKey, displayName: "Ryalts-US" };

function verifiedKill(
  boss: ApplicantDossierBoss
): Extract<ApplicantDossierBoss, { state: "kill" }> {
  if (boss.state !== "kill") throw new Error("expected_verified_kill");
  return boss;
}

function kill(
  character: CharacterKey,
  overrides: Partial<DossierKillEvidence> = {}
): DossierKillEvidence {
  return {
    raidId: "nerubar-palace",
    raidName: "Nerubar's Palace",
    bossId: "queen-ansurek",
    bossName: "Queen Ansurek",
    journalBossId: null,
    bossOrder: 8,
    character,
    killedAt: "2024-10-01T20:00:00.000Z",
    guild: { name: "Example Guild", region: "eu", realm: "silvermoon" },
    historicWorldRank: 147,
    reportUrl: "https://www.warcraftlogs.com/reports/shared#fight=8",
    performance: {
      damage: { state: "unavailable" },
      healing: { state: "unavailable" },
      bossDamage: { state: "unavailable" }
    },
    ...overrides
  };
}

const rankingsUrl =
  "https://www.warcraftlogs.com/character/eu/silvermoon/ryii#zone=1273&boss=2902&difficulty=5";

function tierBest(
  character: CharacterKey,
  overrides: Partial<DossierTierBestParse> = {}
): DossierTierBestParse {
  return {
    raidName: "Nerubar's Palace",
    bossName: "Queen Ansurek",
    character,
    rankingsUrl,
    performance: {
      spec: {
        name: "Destruction",
        iconUrl:
          "https://wow.zamimg.com/images/wow/icons/medium/spell_shadow_rainoffire.jpg"
      },
      damage: { state: "available", percentile: 96.2 },
      healing: { state: "unavailable" },
      bossDamage: { state: "available", percentile: 91 }
    },
    ...overrides
  };
}

function wipe(
  character: CharacterKey,
  overrides: Partial<DossierWipeEvidence> = {}
): DossierWipeEvidence {
  return {
    raidId: "nerubar-palace",
    raidName: "Nerub-ar Palace",
    bossId: "sikran",
    bossName: "Sikran",
    journalBossId: "2599",
    bossOrder: 5,
    character,
    attemptedAt: "2024-09-01T20:00:00.000Z",
    reportUrl: "https://www.warcraftlogs.com/reports/wipe#fight=5",
    ...overrides
  };
}

describe("applicant dossier", () => {
  it("derives final-boss status from the raid catalogue", () => {
    expectTypeOf<"isFinalBoss">().not.toMatchTypeOf<
      keyof DossierKillEvidence
    >();
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [kill(root)],
      limitations: []
    });

    expect(dossier.raids[0]!.bosses[0]!.bossName).toBe("Queen Ansurek");
  });

  it("reports a limitation when a raid kill cannot be matched to the catalogue", () => {
    // Break caught: an unmatched raid zone used to drop the kill with no trace,
    // so a whole tier could read as unkilled and nothing in the dossier said
    // why. Dungeon fights are expected noise; a raid-shaped zone is not.
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [
        kill(root, {
          raidId: "9999",
          raidName: "Some Unreleased Raid",
          bossId: "8888",
          bossName: "Nobody In The Catalogue",
          journalBossId: null,
          killedAt: "2026-08-26T12:00:00.000Z"
        })
      ],
      wipes: [],
      completeWarcraftLogsCharacters: [root],
      limitations: []
    });

    expect(dossier.limitations).toContainEqual(
      expect.objectContaining({
        source: "warcraft_logs",
        character: root,
        code: "unmatched_encounter"
      })
    );
  });

  it("stays silent about a Mythic dungeon it already knows is not a raid", () => {
    // Break caught: `unmatched_encounter` was live on all eight collected
    // characters, and it was Mythic dungeons raising it -- a dungeon boss
    // shares a difficulty with a raid boss, so the scan stored them. The
    // limitation is for evidence going missing, and a dungeon is not missing
    // raid evidence (#346).
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [
        kill(root, {
          raidId: "2290",
          raidName: "Mists of Tirna Scithe",
          bossId: "2419",
          bossName: "Ingra Maloch",
          journalBossId: null,
          killedAt: "2024-10-18T21:18:31.270Z"
        })
      ],
      wipes: [],
      completeWarcraftLogsCharacters: [root],
      limitations: []
    });

    expect(dossier.limitations).not.toContainEqual(
      expect.objectContaining({ code: "unmatched_encounter" })
    );
  });

  it("retains Mythic Tidebound Grotto kills inside its reviewed content window", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      // Shaped from the real Warcraft Logs payloads for these two reports. Both
      // are filed under the Mythic+ season zone, so the raid name arrives from
      // the fight's own game zone and no journal id is available at all — the
      // catalogue has to place the boss by name.
      kills: [
        kill(root, {
          raidId: "2987",
          raidName: "The Tidebound Grotto",
          bossId: "3379",
          bossName: "Nymrissa Wavecaller",
          journalBossId: null,
          bossOrder: 3379,
          killedAt: "2026-08-19T00:00:00.000Z",
          reportUrl:
            "https://www.warcraftlogs.com/reports/V8LFB9HjR4pZYrb6#fight=27"
        }),
        kill(root, {
          raidId: "2987",
          raidName: "The Tidebound Grotto",
          bossId: "3379",
          bossName: "Nymrissa Wavecaller",
          journalBossId: null,
          bossOrder: 3379,
          killedAt: "2026-08-26T12:00:00.000Z",
          reportUrl:
            "https://www.warcraftlogs.com/reports/Aqc9zw1dg7jpmLkZ#fight=23"
        })
      ],
      wipes: [],
      completeWarcraftLogsCharacters: [root],
      limitations: []
    });

    const boss = dossier.raids.find((raid) => raid.raidId === "1317")
      ?.bosses[0];
    expect(boss).toMatchObject({
      state: "kill",
      firstKill: {
        reportUrl:
          "https://www.warcraftlogs.com/reports/V8LFB9HjR4pZYrb6#fight=27"
      }
    });
    if (boss?.state !== "kill") throw new Error("expected_kill");
    expect(boss.firstKills.map((entry) => entry.reportUrl)).toEqual(
      expect.arrayContaining([
        "https://www.warcraftlogs.com/reports/V8LFB9HjR4pZYrb6#fight=27",
        "https://www.warcraftlogs.com/reports/Aqc9zw1dg7jpmLkZ#fight=23"
      ])
    );
  });

  it("aggregates the full catalogue with kill, wipe, no-log, and incomplete precedence", () => {
    // Break caught: missing kills must neither erase concrete wipes nor turn a
    // partial linked-character scan into negative evidence.
    const complete = buildApplicantDossier({
      root,
      characters: [rootCharacter, altCharacter],
      kills: [
        kill(altKey, { raidName: "Nerub-ar Palace", journalBossId: "2602" })
      ],
      wipes: [
        wipe(root),
        wipe(altKey),
        wipe(root, {
          bossName: "Queen Ansurek",
          journalBossId: "2602",
          bossOrder: 8
        })
      ],
      completeWarcraftLogsCharacters: [root, altKey],
      limitations: []
    });
    const nerubar = complete.raids.find(
      (raid) => raid.raidName === "Nerub-ar Palace"
    )!;
    expect(nerubar.bosses.map((boss) => boss.bossOrder)).toEqual(
      [...nerubar.bosses].map((boss) => boss.bossOrder).sort((a, b) => a - b)
    );
    expect(
      nerubar.bosses.find((boss) => boss.bossName === "Queen Ansurek")
    ).toMatchObject({ state: "kill" });
    expect(
      nerubar.bosses.find(
        (boss) => boss.bossName === "Sikran, Captain of the Sureki"
      )
    ).toMatchObject({
      state: "wipe",
      wipe: { characters: [root, altKey] }
    });
    expect(nerubar.bosses.find((boss) => boss.bossOrder === 1)).toMatchObject({
      state: "no_logs"
    });

    const partial = buildApplicantDossier({
      root,
      characters: [rootCharacter, altCharacter],
      kills: [],
      wipes: [],
      completeWarcraftLogsCharacters: [root],
      limitations: [
        { source: "warcraft_logs", character: altKey, code: "private" }
      ]
    });
    expect(partial.raids[0]?.bosses[0]).toMatchObject({ state: "incomplete" });
  });

  it("aggregates fight parses by displayed event and boss", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter, altCharacter],
      kills: [
        kill(root, {
          reportUrl: "https://www.warcraftlogs.com/reports/b#fight=8",
          performance: {
            damage: { state: "available", percentile: 90 },
            healing: { state: "unavailable" },
            bossDamage: { state: "not_applicable" }
          }
        }),
        kill(root, {
          killedAt: "2024-10-01T20:00:01.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/a#fight=8",
          performance: {
            damage: { state: "available", percentile: 90 },
            healing: { state: "not_applicable" },
            bossDamage: { state: "unavailable" }
          }
        }),
        kill(altKey, {
          killedAt: "2024-10-01T20:00:02.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/c#fight=8",
          performance: {
            damage: { state: "available", percentile: 73 },
            healing: { state: "available", percentile: 88 },
            bossDamage: { state: "available", percentile: 66 }
          }
        }),
        kill(root, {
          killedAt: "2024-10-02T20:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/d#fight=8",
          performance: {
            damage: { state: "available", percentile: 95 },
            healing: { state: "available", percentile: 70 },
            bossDamage: { state: "available", percentile: 92 }
          }
        }),
        kill(altKey, {
          killedAt: "2024-10-02T20:00:01.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/e#fight=8",
          performance: {
            damage: { state: "available", percentile: 72 },
            healing: { state: "available", percentile: 99 },
            bossDamage: { state: "available", percentile: 67 }
          }
        })
      ],
      limitations: []
    });

    const boss = verifiedKill(dossier.raids[0]!.bosses[0]!);
    expect(boss.firstKill.parses).toEqual([
      {
        character: "Ryii",
        damage: {
          state: "available",
          percentile: 90,
          reportUrl: "https://www.warcraftlogs.com/reports/a#fight=8"
        },
        healing: { state: "not_applicable" },
        bossDamage: { state: "not_applicable" }
      },
      {
        character: "Ryalts",
        damage: {
          state: "available",
          percentile: 73,
          reportUrl: "https://www.warcraftlogs.com/reports/c#fight=8"
        },
        healing: {
          state: "available",
          percentile: 88,
          reportUrl: "https://www.warcraftlogs.com/reports/c#fight=8"
        },
        bossDamage: {
          state: "available",
          percentile: 66,
          reportUrl: "https://www.warcraftlogs.com/reports/c#fight=8"
        }
      }
    ]);
    expect(boss.bestParses).toEqual([
      {
        character: "Ryii",
        damage: {
          state: "available",
          percentile: 95,
          reportUrl: "https://www.warcraftlogs.com/reports/d#fight=8"
        },
        healing: {
          state: "available",
          percentile: 70,
          reportUrl: "https://www.warcraftlogs.com/reports/d#fight=8"
        },
        bossDamage: {
          state: "available",
          percentile: 92,
          reportUrl: "https://www.warcraftlogs.com/reports/d#fight=8"
        }
      },
      {
        character: "Ryalts",
        damage: {
          state: "available",
          percentile: 73,
          reportUrl: "https://www.warcraftlogs.com/reports/c#fight=8"
        },
        healing: {
          state: "available",
          percentile: 99,
          reportUrl: "https://www.warcraftlogs.com/reports/e#fight=8"
        },
        bossDamage: {
          state: "available",
          percentile: 67,
          reportUrl: "https://www.warcraftlogs.com/reports/e#fight=8"
        }
      }
    ]);
  });

  it("keeps the chronological first kill's metadata and parses as one event", () => {
    // Break caught: latest-first display ordering could combine a later event's
    // provenance with the oldest event's parses in the top first-kill summary.
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter, altCharacter],
      kills: [
        kill(root, {
          killedAt: "2024-10-01T20:00:00.000Z",
          guild: { name: "Earliest", region: "eu", realm: "silvermoon" },
          historicWorldRank: 47,
          reportUrl: "https://www.warcraftlogs.com/reports/earliest#fight=8",
          performance: {
            damage: { state: "available", percentile: 77 },
            healing: { state: "not_applicable" },
            bossDamage: { state: "unavailable" }
          }
        }),
        kill(altKey, {
          killedAt: "2024-10-02T20:00:00.000Z",
          guild: { name: "Later", region: "eu", realm: "draenor" },
          historicWorldRank: 12,
          reportUrl: "https://www.warcraftlogs.com/reports/later#fight=9",
          performance: {
            damage: { state: "available", percentile: 99 },
            healing: { state: "not_applicable" },
            bossDamage: { state: "unavailable" }
          }
        })
      ],
      limitations: []
    });

    const boss = verifiedKill(dossier.raids[0]!.bosses[0]!);
    expect(boss.firstKills.map((event) => event.reportUrl)).toEqual([
      "https://www.warcraftlogs.com/reports/later#fight=9",
      "https://www.warcraftlogs.com/reports/earliest#fight=8"
    ]);
    expect(boss.firstKill).toMatchObject({
      killedAt: "2024-10-01T20:00:00.000Z",
      guild: { name: "Earliest", region: "eu", realm: "silvermoon" },
      historicWorldRank: 47,
      reportUrl: "https://www.warcraftlogs.com/reports/earliest#fight=8",
      characters: [root],
      parses: [
        {
          character: "Ryii",
          damage: {
            state: "available",
            percentile: 77,
            reportUrl: "https://www.warcraftlogs.com/reports/earliest#fight=8"
          }
        }
      ]
    });
    expect(boss.bestParses[1]).toMatchObject({
      character: "Ryalts",
      damage: {
        state: "available",
        percentile: 99,
        reportUrl: "https://www.warcraftlogs.com/reports/later#fight=9"
      }
    });
  });

  it("formats parse character labels without changing canonical attribution", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [{ key: root, displayName: "rYII" }],
      kills: [kill(root)],
      limitations: []
    });

    const boss = verifiedKill(dossier.raids[0]!.bosses[0]!);
    expect(boss.bestParses[0]?.character).toBe("Ryii");
    expect(boss.firstKill.characters).toEqual([root]);
  });

  it("keeps same-named characters' boss parses independent", () => {
    const sameNamedAlt: CharacterKey = {
      region: "us",
      realm: "illidan",
      name: "ryii"
    };
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter, { key: sameNamedAlt, displayName: "Ryii" }],
      kills: [
        kill(root, {
          reportUrl: "https://www.warcraftlogs.com/reports/root#fight=8",
          performance: {
            damage: { state: "available", percentile: 90 },
            healing: { state: "unavailable" },
            bossDamage: { state: "unavailable" }
          }
        }),
        kill(sameNamedAlt, {
          killedAt: "2024-10-02T20:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/alt#fight=8",
          performance: {
            damage: { state: "available", percentile: 70 },
            healing: { state: "unavailable" },
            bossDamage: { state: "unavailable" }
          }
        })
      ],
      limitations: []
    });

    expect(
      verifiedKill(dossier.raids[0]!.bosses[0]!).bestParses.map(
        (parse) => parse.damage
      )
    ).toEqual([
      {
        state: "available",
        percentile: 90,
        reportUrl: "https://www.warcraftlogs.com/reports/root#fight=8"
      },
      {
        state: "available",
        percentile: 70,
        reportUrl: "https://www.warcraftlogs.com/reports/alt#fight=8"
      }
    ]);
  });

  it("credits shared earliest evidence and propagates limitations", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter, altCharacter],
      kills: [
        kill(root, { killedAt: "2024-10-01T21:00:00.000Z" }),
        kill(altKey),
        kill(altKey, { killedAt: "2024-10-02T20:00:00.000Z" })
      ],
      limitations: [
        { source: "warcraft_logs", character: altKey, code: "private" }
      ]
    });
    expect(dossier.raids[0].cuttingEdge).toBeNull();
    expect(
      verifiedKill(dossier.raids[0]!.bosses[0]!).firstKill.characters
    ).toEqual([root, altKey]);
    expect(dossier.limitations[0].code).toBe("private");
  });

  it("attaches all boss wipes after kill evidence from newest to oldest", () => {
    // Break caught: a confirmed kill could discard its wipes or leave them in
    // source order, hiding the most recent progression attempt.
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [
        kill(root, { raidName: "Nerub-ar Palace", journalBossId: "2602" })
      ],
      wipes: [
        wipe(root, {
          bossName: "Queen Ansurek",
          journalBossId: "2602",
          bossOrder: 8,
          attemptedAt: "2024-10-02T20:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/older#fight=2"
        }),
        wipe(root, {
          bossName: "Queen Ansurek",
          journalBossId: "2602",
          bossOrder: 8,
          attemptedAt: "2024-10-04T20:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/latest#fight=4"
        })
      ],
      limitations: []
    });

    const raid = dossier.raids.find(
      (candidate) => candidate.raidName === "Nerub-ar Palace"
    )!;
    const boss = raid.bosses.find(
      (candidate) => candidate.bossName === "Queen Ansurek"
    )!;
    expect(verifiedKill(boss).wipes).toMatchObject([
      { attemptedAt: "2024-10-04T20:00:00.000Z" },
      { attemptedAt: "2024-10-02T20:00:00.000Z" }
    ]);
  });

  it("hides wipes from the same report when building a kill boss", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [
        kill(root, {
          raidName: "Nerub-ar Palace",
          bossName: "Queen Ansurek",
          journalBossId: "2602",
          bossOrder: 8,
          reportUrl: "https://www.warcraftlogs.com/reports/shared#fight=2"
        })
      ],
      wipes: [
        wipe(root, {
          bossName: "Queen Ansurek",
          journalBossId: "2602",
          bossOrder: 8,
          attemptedAt: "2024-10-02T21:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/shared#fight=1"
        }),
        wipe(root, {
          bossName: "Sikran",
          journalBossId: "2599",
          bossOrder: 5,
          attemptedAt: "2024-10-02T22:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/other#fight=3"
        })
      ],
      limitations: []
    });

    const raid = dossier.raids.find(
      (candidate) => candidate.raidName === "Nerub-ar Palace"
    )!;
    const queen = verifiedKill(
      raid.bosses.find((candidate) => candidate.bossName === "Queen Ansurek")!
    );
    expect(queen.wipes).toEqual([]);
    expect(
      raid.bosses.find(
        (candidate) => candidate.bossName === "Sikran, Captain of the Sureki"
      )
    ).toMatchObject({ state: "wipe" });
  });

  it("keeps each character's distinct first kill for the same boss", () => {
    // Break caught: selecting only the dossier-wide earliest kill hid an alt's
    // later, distinct report instead of retaining its own first-kill evidence.
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter, altCharacter],
      kills: [
        kill(root, {
          killedAt: "2024-10-01T20:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/root#fight=8"
        }),
        kill(altKey, {
          killedAt: "2024-10-02T20:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/alt#fight=8"
        })
      ],
      limitations: []
    });

    expect(dossier.raids[0].bosses[0]).toMatchObject({
      firstKills: [
        {
          killedAt: "2024-10-02T20:00:00.000Z",
          characters: [altKey]
        },
        {
          killedAt: "2024-10-01T20:00:00.000Z",
          characters: [root]
        }
      ]
    });
  });

  it("preserves canonical identities for same-named kill participants", () => {
    // Break caught: display-name attribution loses the class-bearing identity
    // when two connected characters share the same visible name.
    const sameNamedAlt: CharacterKey = {
      region: "us",
      realm: "illidan",
      name: "ryii"
    };
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter, { key: sameNamedAlt, displayName: "Ryii" }],
      kills: [kill(sameNamedAlt)],
      limitations: []
    });

    expect(
      verifiedKill(dossier.raids[0]!.bosses[0]!).firstKill.characters
    ).toEqual([sameNamedAlt]);
  });

  it("coalesces duplicate reports of the same guild kill", () => {
    // Break caught: two Warcraft Logs uploads of one guild kill rendered as
    // separate evidence rows and made an applicant's history look inflated.
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter, altCharacter],
      kills: [
        kill(root, {
          killedAt: "2024-10-01T20:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/first#fight=8"
        }),
        kill(altKey, {
          killedAt: "2024-10-01T20:00:01.500Z",
          reportUrl: "https://www.warcraftlogs.com/reports/second#fight=8"
        })
      ],
      limitations: []
    });

    expect(verifiedKill(dossier.raids[0]!.bosses[0]!).firstKills).toEqual([
      expect.objectContaining({
        killedAt: "2024-10-01T20:00:00.000Z",
        reportUrl: "https://www.warcraftlogs.com/reports/first#fight=8",
        characters: [root, altKey]
      })
    ]);
  });

  it("merges same-date reports despite conflicting guild attribution", () => {
    // Break caught: guild disagreement or uploader clock differences split one
    // same-date boss event and hid its complete report and participant evidence.
    const forward = [
      kill(root, {
        killedAt: "2024-10-01T23:59:00.000Z",
        guild: { name: "Zeta Guild", region: "eu", realm: "silvermoon" },
        historicWorldRank: 5,
        reportUrl: "https://www.warcraftlogs.com/reports/a-report#fight=8"
      }),
      kill(altKey, {
        killedAt: "2024-10-01T00:01:00.000Z",
        guild: { name: "Alpha Guild", region: "eu", realm: "draenor" },
        historicWorldRank: null,
        reportUrl: "https://www.warcraftlogs.com/reports/z-report#fight=9"
      })
    ];
    const make = (kills: readonly DossierKillEvidence[]) =>
      buildApplicantDossier({
        root,
        characters: [rootCharacter, altCharacter],
        kills,
        limitations: []
      });

    expect(make([...forward].reverse())).toEqual(make(forward));
    expect(verifiedKill(make(forward).raids[0]!.bosses[0]!).firstKills).toEqual(
      [
        expect.objectContaining({
          guild: { name: "Alpha Guild", region: "eu", realm: "draenor" },
          historicWorldRank: null,
          reportUrls: [
            "https://www.warcraftlogs.com/reports/a-report#fight=8",
            "https://www.warcraftlogs.com/reports/z-report#fight=9"
          ],
          characters: [root, altKey]
        })
      ]
    );
  });

  it("uses the available guild when same-date attribution is absent", () => {
    // Break caught: a null guild prevented same-date reports from being merged
    // even when another report supplied the display attribution.
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter, altCharacter],
      kills: [
        kill(root, {
          killedAt: "2024-10-01T01:00:00.000Z",
          guild: null,
          reportUrl: "https://www.warcraftlogs.com/reports/unguilded#fight=8"
        }),
        kill(altKey, {
          killedAt: "2024-10-01T22:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/attributed#fight=8"
        })
      ],
      limitations: []
    });

    expect(verifiedKill(dossier.raids[0]!.bosses[0]!).firstKills).toEqual([
      expect.objectContaining({
        guild: { name: "Example Guild", region: "eu", realm: "silvermoon" },
        characters: [root, altKey]
      })
    ]);
  });

  it("keeps different UTC dates and regions as distinct kill events", () => {
    // Break caught: broad same-boss grouping could merge events across either
    // the UTC calendar boundary or the Warcraft Logs region boundary.
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter, altCharacter, usAltCharacter],
      kills: [
        kill(root, {
          killedAt: "2024-10-01T23:59:59.999Z",
          reportUrl: "https://www.warcraftlogs.com/reports/eu-first#fight=8"
        }),
        kill(altKey, {
          killedAt: "2024-10-02T00:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/eu-second#fight=8"
        }),
        kill(usAltKey, {
          killedAt: "2024-10-01T12:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/us#fight=8"
        })
      ],
      limitations: []
    });

    expect(verifiedKill(dossier.raids[0]!.bosses[0]!).firstKills).toHaveLength(
      3
    );
  });

  it("orders tied distinct events deterministically regardless of input order", () => {
    // Break caught: cross-region events at the same timestamp could inherit
    // Warcraft Logs input order instead of applying the secondary comparator.
    const forward = [
      kill(root, {
        reportUrl: "https://www.warcraftlogs.com/reports/a#fight=8"
      }),
      kill(usAltKey, {
        reportUrl: "https://www.warcraftlogs.com/reports/z#fight=8"
      })
    ];
    const make = (kills: DossierKillEvidence[]) =>
      buildApplicantDossier({
        root,
        characters: [rootCharacter, usAltCharacter],
        kills,
        limitations: []
      });

    expect(
      verifiedKill(make(forward).raids[0]!.bosses[0]!).firstKills.map(
        (evidence) => evidence.reportUrl
      )
    ).toEqual([
      "https://www.warcraftlogs.com/reports/z#fight=8",
      "https://www.warcraftlogs.com/reports/a#fight=8"
    ]);
    expect(make([...forward].reverse())).toEqual(make(forward));
  });

  it("keeps different bosses as distinct kill events", () => {
    // Break caught: date-based grouping must remain scoped by the normalized
    // raid and boss identity established before evidence aggregation.
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter, altCharacter],
      kills: [
        kill(root, { journalBossId: "2602" }),
        kill(altKey, {
          bossName: "Sikran",
          journalBossId: "2599",
          reportUrl: "https://www.warcraftlogs.com/reports/sikran#fight=2"
        })
      ],
      limitations: []
    });

    expect(dossier.raids[0]!.bosses).toHaveLength(2);
  });

  it("uses the same result when tied evidence input is reversed", () => {
    const forward = [
      kill(root, { killedAt: "2024-10-01T20:00:00.000Z" }),
      kill(altKey, { killedAt: "2024-10-01T20:00:00.000Z" })
    ];
    const reverse = [...forward].reverse();
    const make = (kills: DossierKillEvidence[]) =>
      buildApplicantDossier({
        root,
        characters: [rootCharacter, altCharacter],
        kills,
        limitations: []
      });
    expect(make(reverse)).toEqual(make(forward));
    expect(make(forward).raids[0].cuttingEdge).toBeNull();
  });

  it("distinguishes nullable evidence values when tied input is reversed", () => {
    const forward = [
      kill(root, { reportUrl: null, guild: null, historicWorldRank: null }),
      kill(root, {
        reportUrl: "",
        guild: { name: "", region: "eu", realm: "" },
        historicWorldRank: Number.MAX_SAFE_INTEGER
      })
    ];
    const make = (kills: DossierKillEvidence[]) =>
      buildApplicantDossier({
        root,
        characters: [rootCharacter],
        kills,
        limitations: []
      });

    expect(make([...forward].reverse())).toEqual(make(forward));
  });

  it("keeps unavailable historic ranks unknown", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [kill(root, { historicWorldRank: null, reportUrl: null })],
      limitations: []
    });
    expect(
      verifiedKill(dossier.raids[0]!.bosses[0]!).firstKill.historicWorldRank
    ).toBeNull();
  });

  it("uses generated Journal metadata when Warcraft Logs supplies a Journal encounter", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [
        kill(root, {
          journalBossId: "2602",
          raidId: "wcl-zone",
          raidName: "WCL zone name",
          bossId: "wcl-encounter",
          bossName: "WCL boss name",
          bossOrder: 99
        })
      ],
      limitations: []
    });

    expect(dossier.raids[0]).toMatchObject({
      raidId: "1273",
      raidName: "Nerub-ar Palace",
      imageUrl: expect.stringMatching(/^https:\/\//),
      bosses: [
        {
          bossId: "2602",
          bossName: "Queen Ansurek",
          bossOrder: 8,
          imageUrl: expect.stringMatching(/^https:\/\//)
        }
      ]
    });
  });

  it("keeps mapped and unmapped bosses in the same generated raid section", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [
        kill(root, { raidName: "Nerub-ar Palace", journalBossId: "2602" }),
        kill(root, {
          raidName: "Nerub-ar Palace",
          bossId: "unmapped",
          bossName: "Unmapped boss",
          journalBossId: null
        })
      ],
      limitations: []
    });

    expect(dossier.raids).toHaveLength(1);
    expect(dossier.raids[0]?.raidId).toBe("1273");
  });

  it("uses the earliest Cutting Edge completion without character attribution", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter, altCharacter],
      kills: [],
      cuttingEdges: [
        {
          achievementId: "40254",
          completedAt: "2025-01-14T20:30:00.000Z"
        },
        {
          achievementId: "40254",
          completedAt: "2025-02-14T20:30:00.000Z"
        },
        {
          achievementId: "1",
          completedAt: "2025-01-14T20:30:00.000Z"
        }
      ],
      limitations: []
    });

    expect(dossier.cuttingEdges).toEqual([
      expect.objectContaining({
        achievementId: "40254",
        achievementName: "Cutting Edge: Queen Ansurek",
        completedAt: "2025-01-14T20:30:00.000Z",
        iconUrl: "https://render.worldofwarcraft.com/eu/icons/56/5779391.jpg"
      })
    ]);
  });

  it("groups same-date timestamp fallbacks, retains reports, and sorts latest first", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter, altCharacter],
      kills: [
        kill(root, { killedAt: "2024-10-04T20:00:00.000Z", reportUrl: null }),
        kill(root, { killedAt: "2024-10-03T20:00:00.000Z", reportUrl: null }),
        kill(altKey, { killedAt: "2024-10-03T20:00:00.000Z", reportUrl: null }),
        kill(root, {
          killedAt: "2024-10-02T20:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/later#fight=8"
        }),
        kill(root),
        kill(root),
        kill(altKey)
      ],
      limitations: []
    });
    expect(verifiedKill(dossier.raids[0]!.bosses[0]!).firstKills).toEqual([
      expect.objectContaining({
        killedAt: "2024-10-04T20:00:00.000Z",
        characters: [root]
      }),
      expect.objectContaining({
        killedAt: "2024-10-03T20:00:00.000Z",
        characters: [root, altKey]
      }),
      expect.objectContaining({
        killedAt: "2024-10-02T20:00:00.000Z",
        characters: [root]
      }),
      expect.objectContaining({
        killedAt: "2024-10-01T20:00:00.000Z",
        characters: [root, altKey]
      })
    ]);
  });

  it("orders tiers by release and bosses final-first then descending encounter order", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [
        kill(root, {
          raidName: "Nerub-ar Palace",
          bossName: "Sikran",
          journalBossId: "2599"
        }),
        kill(root, {
          raidName: "Nerub-ar Palace",
          journalBossId: "2602"
        }),
        kill(root, {
          raidName: "Amirdrassil, the Dream's Hope",
          bossName: "Fyrakk the Blazing",
          journalBossId: "2519"
        }),
        kill(root, {
          raidName: "Aberrus, the Shadowed Crucible",
          bossName: "Scalecommander Sarkareth",
          journalBossId: "2520"
        }),
        // An unclassified zone must not be presented as a raid: it could be a
        // dungeon or another non-raid instance.
        kill(root, {
          raidId: "unknown",
          raidName: "Unknown instance",
          bossId: "unknown",
          bossName: "Unknown Boss",
          bossOrder: 1
        })
      ],
      limitations: []
    });
    expect(dossier.raids.map((raid) => raid.raidName)).toEqual([
      "Nerub-ar Palace"
    ]);
    expect(dossier.raids[0]!.bosses.map((boss) => boss.bossName)).toEqual([
      "Queen Ansurek",
      "Sikran, Captain of the Sureki"
    ]);
  });

  it("orders merged Cutting Edge achievements newest completion first", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [],
      limitations: [],
      cuttingEdges: [
        {
          achievementId: "40254",
          completedAt: "2025-01-14T20:30:00.000Z"
        },
        {
          achievementId: "41297",
          completedAt: "2025-05-14T20:30:00.000Z"
        }
      ]
    });
    expect(dossier.cuttingEdges.map((entry) => entry.achievementId)).toEqual([
      "41297",
      "40254"
    ]);
  });

  it("does not retain character identity on Cutting Edge evidence", () => {
    const sameNamedAlt: CharacterKey = {
      region: "us",
      realm: "illidan",
      name: "ryii"
    };
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter, { key: sameNamedAlt, displayName: "Ryii" }],
      kills: [],
      cuttingEdges: [
        {
          achievementId: "40254",
          completedAt: "2025-01-14T20:30:00.000Z"
        }
      ],
      limitations: []
    });

    expect(dossier.cuttingEdges[0]).not.toHaveProperty("characters");
  });

  it("keeps the full verified Raider.IO boss slug when a name includes a subtitle", () => {
    expect(
      lookupRaiderIoBoss("Crucible of Storms", "Uu'nat, Harbinger of the Void")
    ).toEqual({
      raidSlug: "crucible-of-storms",
      bossSlug: "uunat-harbinger-of-the-void"
    });
    expect(
      lookupRaiderIoBoss("Nerub-ar Palace", "Sikran, Captain of the Sureki")
    ).toEqual({ raidSlug: "nerubar-palace", bossSlug: "sikran" });
  });

  it("excludes Mythic+ season zones from raid boss evidence", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [
        kill(root, {
          raidName: "Mythic+ Season 1",
          bossName: "Lightblinded Vanguard"
        }),
        kill(root, { raidName: "Nerub-ar Palace", journalBossId: "2602" })
      ],
      limitations: []
    });

    expect(dossier.raids).toEqual([
      expect.objectContaining({ raidName: "Nerub-ar Palace" })
    ]);
  });

  it("excludes plural Mythic+ season zones when their boss cannot identify a raid", () => {
    // Break caught: an ambiguous reused boss name could be presented beneath a
    // Mythic+ seasonal zone as if it were raid evidence.
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [
        kill(root, {
          raidName: "Mythic+ Seasons 1 - 3",
          bossName: "Artificer Xy'mox",
          journalBossId: null
        }),
        kill(root, { raidName: "Nerub-ar Palace", journalBossId: "2602" })
      ],
      limitations: []
    });

    expect(dossier.raids).toEqual([
      expect.objectContaining({ raidName: "Nerub-ar Palace" })
    ]);
  });

  it("excludes generic dungeon zones from historic raid evidence", () => {
    // Break caught: dungeon encounters such as Brewmaster Aldryr could appear
    // in the applicant's raid history when Warcraft Logs uses a generic zone.
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [
        kill(root, {
          raidName: "Heroic Dungeons",
          bossName: "Brewmaster Aldryr",
          journalBossId: null
        }),
        kill(root, { raidName: "Nerub-ar Palace", journalBossId: "2602" })
      ],
      limitations: []
    });

    expect(dossier.raids).toEqual([
      expect.objectContaining({ raidName: "Nerub-ar Palace" })
    ]);
  });

  it("excludes Dragon Isles world-boss evidence from historic raids", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [
        kill(root, {
          raidId: "1205",
          raidName: "Dragon Isles",
          bossId: "2515",
          bossName: "Strunraan, The Sky's Misery",
          journalBossId: "2515"
        }),
        kill(root, { raidName: "Nerub-ar Palace", journalBossId: "2602" })
      ],
      limitations: []
    });

    expect(dossier.raids).toEqual([
      expect.objectContaining({ raidName: "Nerub-ar Palace" })
    ]);
  });

  it("excludes named dungeon zones from historic raid evidence", () => {
    // Break caught: a named dungeon zone could bypass the generic-zone filter
    // and present its boss as raid evidence.
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [
        kill(root, {
          raidName: "Cinderbrew Meadery",
          bossName: "Brewmaster Aldryr",
          journalBossId: null
        }),
        kill(root, { raidName: "Nerub-ar Palace", journalBossId: "2602" })
      ],
      limitations: []
    });

    expect(dossier.raids).toEqual([
      expect.objectContaining({ raidName: "Nerub-ar Palace" })
    ]);
  });

  it("excludes a dungeon boss reported under a raid zone", () => {
    // Break caught: a WCL report listed Brewmaster Aldryr under Liberation of
    // Undermine. A recognised zone alone must not turn an unknown boss into
    // raid evidence.
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [
        kill(root, {
          raidName: "Liberation of Undermine",
          bossName: "Brewmaster Aldryr",
          journalBossId: null
        }),
        kill(root, { raidName: "Nerub-ar Palace", journalBossId: "2602" })
      ],
      limitations: []
    });

    expect(dossier.raids).toEqual([
      expect.objectContaining({ raidName: "Nerub-ar Palace" })
    ]);
  });

  it("uses unique boss metadata when Warcraft Logs groups Midnight raids under one zone", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [
        kill(root, {
          raidId: "combined-midnight-zone",
          raidName: "VS / DR / MQD",
          bossId: "wcl-chimaerus",
          bossName: "Chimaerus the Undreamt God",
          journalBossId: null,
          killedAt: "2026-04-01T20:00:00.000Z"
        }),
        kill(root, {
          raidId: "combined-midnight-zone",
          raidName: "VS / DR / MQD",
          bossId: "wcl-midnight-falls",
          bossName: "Midnight Falls",
          journalBossId: null,
          killedAt: "2026-04-01T20:00:00.000Z"
        })
      ],
      limitations: []
    });

    expect(dossier.raids.map((raid) => raid.raidName)).toEqual([
      "The Dreamrift",
      "March on Quel'Danas"
    ]);
  });
});

describe("historic tier current-content windows", () => {
  // Break caught: Sepulcher of the First Ones had no generated current-content
  // window, so currentness() could not judge a 2022 kill and every Mythic kill
  // in the tier was discarded while its wipes from the same reports stayed. A
  // reviewer saw a raider who only ever wiped.
  it("shows a Sepulcher kill earned while the tier was current", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [
        kill(root, {
          raidId: "1195",
          raidName: "Sepulcher of the First Ones",
          bossId: "2458",
          bossName: "Vigilant Guardian",
          journalBossId: "2458",
          bossOrder: 1,
          killedAt: "2022-04-13T20:00:00.000Z"
        })
      ],
      wipes: [],
      limitations: []
    });
    const sepulcher = dossier.raids.find(
      (raid) => raid.raidName === "Sepulcher of the First Ones"
    );
    expect(
      sepulcher?.bosses
        .filter((boss) => boss.state === "kill")
        .map((boss) => boss.bossName)
    ).toEqual(["Vigilant Guardian"]);
    expect(
      dossier.limitations.filter((limitation) =>
        limitation.code.startsWith("current_content_")
      )
    ).toEqual([]);
  });

  it("still withholds a legacy clear earned after the tier closed", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [
        kill(root, {
          raidId: "1195",
          raidName: "Sepulcher of the First Ones",
          bossId: "2458",
          bossName: "Vigilant Guardian",
          journalBossId: "2458",
          bossOrder: 1,
          killedAt: "2025-01-01T20:00:00.000Z"
        })
      ],
      wipes: [],
      limitations: []
    });
    const sepulcher = dossier.raids.find(
      (raid) => raid.raidName === "Sepulcher of the First Ones"
    );
    expect(sepulcher?.bosses.some((boss) => boss.state === "kill")).toBe(false);
    expect(dossier.limitations.map((limitation) => limitation.code)).toEqual([
      "current_content_evidence_withheld"
    ]);
  });

  it("reports the character's tier best above the best of the displayed kills", () => {
    // Break caught: a best parse assembled from displayed evidence alone can be
    // worse than the character's actual best, because the better kill sits in a
    // report the parse budget never reached or outside the shown window.
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [
        kill(root, {
          reportUrl: "https://www.warcraftlogs.com/reports/shown#fight=8",
          performance: {
            damage: { state: "available", percentile: 80 },
            healing: { state: "unavailable" },
            bossDamage: { state: "unavailable" }
          }
        })
      ],
      tierBests: [tierBest(root)],
      limitations: []
    });

    const boss = verifiedKill(dossier.raids[0]!.bosses[0]!);
    // The first-kill row still answers for its own fight.
    expect(boss.firstKill.parses[0]).toMatchObject({
      damage: {
        state: "available",
        percentile: 80,
        reportUrl: "https://www.warcraftlogs.com/reports/shown#fight=8"
      }
    });
    expect(boss.bestParses).toEqual([
      {
        character: "Ryii",
        spec: {
          name: "Destruction",
          iconUrl:
            "https://wow.zamimg.com/images/wow/icons/medium/spell_shadow_rainoffire.jpg"
        },
        damage: {
          state: "available",
          percentile: 96.2,
          reportUrl: rankingsUrl
        },
        healing: { state: "unavailable" },
        bossDamage: {
          state: "available",
          percentile: 91,
          reportUrl: rankingsUrl
        }
      }
    ]);
  });

  it("keeps a displayed parse that beats the tier best read for it", () => {
    // Break caught: zone rankings are read per tier and per run, so one that is
    // stale or partial must never pull a shown value down.
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [
        kill(root, {
          reportUrl: "https://www.warcraftlogs.com/reports/shown#fight=8",
          performance: {
            damage: { state: "available", percentile: 99 },
            healing: { state: "unavailable" },
            bossDamage: { state: "unavailable" }
          }
        })
      ],
      tierBests: [
        tierBest(root, {
          performance: {
            damage: { state: "available", percentile: 40 },
            healing: { state: "unavailable" },
            bossDamage: { state: "unavailable" }
          }
        })
      ],
      limitations: []
    });

    expect(
      verifiedKill(dossier.raids[0]!.bosses[0]!).bestParses[0]
    ).toMatchObject({
      damage: {
        state: "available",
        percentile: 99,
        reportUrl: "https://www.warcraftlogs.com/reports/shown#fight=8"
      }
    });
  });

  it("offers no tier best to a character with no displayed kill on the boss", () => {
    // Break caught: zone rankings cover every encounter in the zone, so a
    // character ranked on a boss they have no shown kill for would otherwise
    // gain a parse row on evidence the dossier never listed.
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter, altCharacter],
      kills: [kill(root)],
      tierBests: [tierBest(altKey)],
      limitations: []
    });

    expect(
      verifiedKill(dossier.raids[0]!.bosses[0]!).bestParses.map(
        (parse) => parse.character
      )
    ).toEqual(["Ryii"]);
  });
});

// Break caught: the gate pushed one limitation per discarded kill, so a farming
// alt produced hundreds of identical rows that buried every other limitation.
it("reports one withheld-evidence limitation per character and reason", () => {
  const legacy = (killedAt: string, bossId: string) =>
    kill(root, {
      raidId: "1195",
      raidName: "Sepulcher of the First Ones",
      bossId,
      bossName: "Vigilant Guardian",
      journalBossId: bossId,
      bossOrder: 1,
      killedAt
    });
  const dossier = buildApplicantDossier({
    root,
    characters: [rootCharacter, altCharacter],
    kills: [
      legacy("2025-01-01T20:00:00.000Z", "2458"),
      legacy("2025-01-02T20:00:00.000Z", "2465"),
      legacy("2025-01-03T20:00:00.000Z", "2470"),
      { ...legacy("2025-01-04T20:00:00.000Z", "2458"), character: altKey }
    ],
    wipes: [],
    limitations: []
  });
  expect(
    dossier.limitations.map((limitation) => [
      limitation.character?.name,
      limitation.code
    ])
  ).toEqual([
    ["ryii", "current_content_evidence_withheld"],
    ["ryalts", "current_content_evidence_withheld"]
  ]);
});
