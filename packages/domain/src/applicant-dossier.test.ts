import { describe, expect, it } from "vitest";
import type { CharacterKey } from "./character-key";
import {
  buildApplicantDossier,
  type DossierKillEvidence
} from "./applicant-dossier";

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
    expect(dossier.raids[0].cuttingEdge).toBe(true);
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
    expect(make(forward).raids[0].cuttingEdge).toBe(true);
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
      bosses: [{ bossId: "2602", bossName: "Queen Ansurek", bossOrder: 8 }]
    });
  });
});
