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

  it("keeps unavailable historic ranks unknown", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter],
      kills: [kill(root, { historicWorldRank: null, reportUrl: null })],
      limitations: []
    });
    expect(dossier.raids[0].bosses[0].firstKill.historicWorldRank).toBeNull();
  });
});
