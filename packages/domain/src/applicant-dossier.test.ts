import { describe, expect, it } from "vitest";
import type { CharacterKey } from "./character-key";
import {
  buildApplicantDossier,
  type DossierKillEvidence
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
    isFinalBoss: true,
    character,
    killedAt: "2024-10-01T20:00:00.000Z",
    guild: { name: "Example Guild", realm: "silvermoon" },
    historicWorldRank: 147,
    reportUrl: "https://www.warcraftlogs.com/reports/shared#fight=8",
    ...overrides
  };
}

describe("applicant dossier", () => {
  it("credits shared earliest evidence and propagates limitations", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter, altCharacter],
      kills: [
        kill(root, { killedAt: "2024-10-03T20:00:00.000Z" }),
        kill(altKey),
        kill(altKey, { killedAt: "2024-10-02T20:00:00.000Z" })
      ],
      limitations: [
        { source: "warcraft_logs", character: altKey, code: "private" }
      ]
    });
    expect(dossier.raids[0].cuttingEdge).toBeNull();
    expect(dossier.raids[0].bosses[0].firstKill.characters).toEqual([
      "Ryii",
      "Ryalts"
    ]);
    expect(dossier.limitations[0].code).toBe("private");
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
          killedAt: "2024-10-01T20:00:00.000Z",
          characters: ["Ryii"]
        },
        {
          killedAt: "2024-10-02T20:00:00.000Z",
          characters: ["Ryalts"]
        }
      ]
    });
  });

  it("uses the same result when tied evidence input is reversed", () => {
    const forward = [
      kill(root, { killedAt: "2024-10-01T20:00:00.000Z", isFinalBoss: false }),
      kill(altKey, { killedAt: "2024-10-01T20:00:00.000Z", isFinalBoss: true })
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

  it("uses deterministic descriptive metadata when tied evidence is reversed", () => {
    const forward = [
      kill(root, {
        raidName: "Zeta Raid",
        bossName: "Zeta Boss",
        bossOrder: 9
      }),
      kill(root, {
        raidName: "Alpha Raid",
        bossName: "Alpha Boss",
        bossOrder: 1
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
    expect(make(forward).raids[0]).toMatchObject({ raidName: "Alpha Raid" });
    expect(make(forward).raids[0].bosses[0]).toMatchObject({
      bossName: "Alpha Boss",
      bossOrder: 1
    });
  });

  it("distinguishes nullable evidence values when tied input is reversed", () => {
    const forward = [
      kill(root, { reportUrl: null, guild: null, historicWorldRank: null }),
      kill(root, {
        reportUrl: "",
        guild: { name: "", realm: "" },
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
    expect(dossier.raids[0].bosses[0].firstKill.historicWorldRank).toBeNull();
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

  it("merges Cutting Edge dates using the earliest completion and all qualifying characters", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter, altCharacter],
      kills: [],
      cuttingEdges: [
        {
          achievementId: "40254",
          completedAt: "2025-01-14T20:30:00.000Z",
          character: root
        },
        {
          achievementId: "40254",
          completedAt: "2025-02-14T20:30:00.000Z",
          character: altKey
        },
        {
          achievementId: "1",
          completedAt: "2025-01-14T20:30:00.000Z",
          character: root
        }
      ],
      limitations: []
    });

    expect(dossier.cuttingEdges).toEqual([
      expect.objectContaining({
        achievementId: "40254",
        achievementName: "Cutting Edge: Queen Ansurek",
        completedAt: "2025-01-14T20:30:00.000Z",
        characters: ["Ryii", "Ryalts"],
        iconUrl: "https://render.worldofwarcraft.com/eu/icons/56/5779391.jpg"
      })
    ]);
  });

  it("retains distinct reports and timestamp fallbacks, credits shared reports, and sorts oldest first", () => {
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
    expect(dossier.raids[0]!.bosses[0]!.firstKills).toEqual([
      expect.objectContaining({
        killedAt: "2024-10-01T20:00:00.000Z",
        characters: ["Ryii", "Ryalts"]
      }),
      expect.objectContaining({
        killedAt: "2024-10-02T20:00:00.000Z",
        characters: ["Ryii"]
      }),
      expect.objectContaining({
        killedAt: "2024-10-03T20:00:00.000Z",
        characters: ["Ryalts"]
      }),
      expect.objectContaining({
        killedAt: "2024-10-03T20:00:00.000Z",
        characters: ["Ryii"]
      }),
      expect.objectContaining({
        killedAt: "2024-10-04T20:00:00.000Z",
        characters: ["Ryii"]
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
          journalBossId: "2599",
          isFinalBoss: false
        }),
        kill(root, {
          raidName: "Nerub-ar Palace",
          journalBossId: "2602",
          isFinalBoss: false
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
        kill(root, {
          raidId: "unknown",
          raidName: "Unknown raid",
          bossId: "final",
          bossName: "Final",
          bossOrder: 1
        }),
        kill(root, {
          raidId: "unknown",
          raidName: "Unknown raid",
          bossId: "earlier",
          bossName: "Earlier",
          bossOrder: 2,
          isFinalBoss: false
        })
      ],
      limitations: []
    });
    expect(dossier.raids.map((raid) => raid.raidName)).toEqual([
      "Nerub-ar Palace",
      "Amirdrassil, the Dream's Hope",
      "Aberrus, the Shadowed Crucible",
      "Unknown raid"
    ]);
    expect(dossier.raids[0]!.bosses.map((boss) => boss.bossName)).toEqual([
      "Queen Ansurek",
      "Sikran, Captain of the Sureki"
    ]);
    expect(dossier.raids[3]!.bosses.map((boss) => boss.bossName)).toEqual([
      "Final",
      "Earlier"
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
          completedAt: "2025-01-14T20:30:00.000Z",
          character: root
        },
        {
          achievementId: "41297",
          completedAt: "2025-05-14T20:30:00.000Z",
          character: root
        }
      ]
    });
    expect(dossier.cuttingEdges.map((entry) => entry.achievementId)).toEqual([
      "41297",
      "40254"
    ]);
  });

  it("credits Cutting Edge only to the matching canonical character identity", () => {
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
          completedAt: "2025-01-14T20:30:00.000Z",
          character: root
        }
      ],
      limitations: []
    });

    expect(dossier.cuttingEdges[0]!.characters).toEqual(["Ryii"]);
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
          journalBossId: null
        }),
        kill(root, {
          raidId: "combined-midnight-zone",
          raidName: "VS / DR / MQD",
          bossId: "wcl-midnight-falls",
          bossName: "Midnight Falls",
          journalBossId: null
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
