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
    raidName: "Nerub'ar Palace",
    bossId: "queen-ansurek",
    bossName: "Queen Ansurek",
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
  it("credits all linked characters for shared earliest final-boss evidence", () => {
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

    expect(dossier.raids[0]).toMatchObject({
      raidId: "nerubar-palace",
      cuttingEdge: true
    });
    expect(dossier.raids[0].bosses[0].firstKill).toMatchObject({
      killedAt: "2024-10-01T20:00:00.000Z",
      characters: ["Ryii", "Ryalts"]
    });
    expect(dossier.limitations[0]).toEqual({
      source: "warcraft_logs",
      character: altKey,
      code: "private"
    });
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

  it("orders raids and bosses by their stable evidence order", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [
        kill(root, {
          raidId: "amirdrassil",
          raidName: "Amirdrassil",
          bossId: "fyrakk",
          bossName: "Fyrakk",
          bossOrder: 9,
          isFinalBoss: true
        }),
        kill(root, {
          bossId: "silken-court",
          bossName: "The Silken Court",
          bossOrder: 7,
          isFinalBoss: false
        }),
        kill(root)
      ],
      limitations: []
    });

    expect(dossier.raids.map((raid) => raid.raidId)).toEqual([
      "amirdrassil",
      "nerubar-palace"
    ]);
    expect(dossier.raids[1].bosses.map((boss) => boss.bossId)).toEqual([
      "silken-court",
      "queen-ansurek"
    ]);
  });
});
