import { describe, expect, it, vi } from "vitest";
import {
  buildApplicantDossier,
  type DossierKillEvidence,
  type DossierRaiderIoFirstKill
} from "./applicant-dossier";
import type { DossierCharacter } from "./applicant-dossier";

// Returning to a per-first-kill scan must fail even with warm catalogue caches.
// The names are fresh raw inputs that still resolve to the same real catalogue
// entry; global spies observe internal ESM calls without adding a public seam.
describe("first-kill assembly growth", () => {
  it.each([false, true])(
    "adds linear timestamp/normalisation work (withheld=%s)",
    (withheld) => {
      const characters: DossierCharacter[] = Array.from(
        { length: 14 },
        (_, i) => ({
          key: {
            region: "eu",
            realm: "silvermoon",
            name: `growth${i}`
          },
          displayName: `Growth ${i}`
        })
      );
      const killedAt = withheld
        ? "2026-01-01T20:00:00.000Z"
        : "2024-10-01T20:00:00.000Z";
      const measure = (firstCount: number, cold: string) => {
        const kills: DossierKillEvidence[] = Array.from(
          { length: 3406 },
          (_, i) => ({
            character: characters[i % 14]!.key,
            raidId: "nerubar-palace",
            raidName: `Nerub-ar Palace${cold}`,
            bossId: "queen-ansurek",
            bossName: `Queen Ansurek${cold}`,
            journalBossId: "2602",
            bossOrder: 8,
            killedAt,
            guild: null,
            historicWorldRank: null,
            reportUrl: `https://www.warcraftlogs.com/reports/growth${i}#fight=1`,
            performance: {
              damage: { state: "available", percentile: 0 },
              healing: { state: "not_applicable" },
              bossDamage: { state: "unavailable" }
            }
          })
        );
        const firsts: DossierRaiderIoFirstKill[] = Array.from(
          { length: firstCount },
          (_, i) => ({
            character: { ...characters[i % 14]!.key },
            raidSlug: "nerubar-palace",
            bossSlug: "queen-ansurek",
            // Outside the matching window forces every old eligible/withheld scan
            // to inspect all candidates rather than short-circuit on its first row.
            killedAt: withheld
              ? "2026-01-02T20:00:00.000Z"
              : "2024-10-02T20:00:00.000Z",
            guild: null,
            historicWorldRank: null,
            encounter: { state: "not_read" }
          })
        );
        const parse = vi.spyOn(Date, "parse");
        const normalize = vi.spyOn(String.prototype, "normalize");
        try {
          const dossier = buildApplicantDossier({
            root: characters[0]!.key,
            characters,
            kills,
            raiderIoFirstKills: firsts,
            limitations: [],
            cuttingEdges: []
          });
          if (withheld) {
            expect(
              dossier.limitations.some(
                (limitation) => limitation.source === "raiderio"
              )
            ).toBe(true);
          } else {
            expect(
              dossier.raids.some((raid) =>
                raid.bosses.some((boss) => boss.state === "kill")
              )
            ).toBe(true);
          }
          return {
            parses: parse.mock.calls.length,
            normalizations: normalize.mock.calls.length
          };
        } finally {
          parse.mockRestore();
          normalize.mockRestore();
        }
      };
      const one = measure(170, withheld ? "!?" : "!!");
      const two = measure(340, withheld ? "?!" : "??");
      // At fixed K, another 170 first kills may parse their own timestamps and
      // catalogue windows. They must not re-parse thousands of unrelated kills.
      expect(two.parses - one.parses).toBeLessThan(170 * 20);
      expect(two.normalizations - one.normalizations).toBeLessThan(170 * 20);
    }
  );
});
