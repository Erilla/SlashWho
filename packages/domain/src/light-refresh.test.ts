import { describe, expect, it } from "vitest";
import { decideLightRefresh } from "./light-refresh";

const at = new Date("2026-10-13T12:00:00Z");
const completed = {
  run: { limitationCode: null, parseLimitationCode: null }
};
const stored = {
  kills: [{ raidId: "zone", killedAt: "2026-09-01T00:00:00Z" }],
  wipes: [],
  lastCleanKillScanAt: "2026-09-01T00:00:00Z"
};
const terminal = [
  { raidId: "zone", domain: "kills" as const },
  { raidId: "zone", domain: "parses" as const },
  { raidId: "zone", domain: "tier_bests" as const }
];
const kills = [
  { raidId: "zone", killedAt: "2026-09-01T00:00:00Z", fightUrl: "fight" }
];

function input(overrides: Record<string, unknown> = {}) {
  return {
    at,
    completed,
    completedVersionCurrent: true,
    stored,
    terminal,
    recoveredAt: new Date("2026-10-12T12:00:00Z"),
    kills,
    hydratedFightUrls: ["fight"],
    collectedTierZones: [["zone", "2026-10-01T00:00:00Z"]] as const,
    ...overrides
  };
}

describe("decideLightRefresh", () => {
  it("allows a light run only when all settlement evidence is complete", () => {
    expect(decideLightRefresh(input())).toBe(true);
    expect(decideLightRefresh(input({ hydratedFightUrls: [] }))).toBe(false);
    expect(decideLightRefresh(input({ recoveredAt: null }))).toBe(false);
    expect(decideLightRefresh(input({ completedVersionCurrent: false }))).toBe(
      false
    );
  });

  it("requires every stored tier to be terminal for kills", () => {
    expect(
      decideLightRefresh(
        input({ stored: { ...stored, wipes: [{ raidId: "other" }] } })
      )
    ).toBe(false);
  });

  it("rejects incomplete scan, limitation and recent content cases", () => {
    expect(
      decideLightRefresh(
        input({
          completed: {
            run: { limitationCode: "limited", parseLimitationCode: null }
          }
        })
      )
    ).toBe(false);
    expect(
      decideLightRefresh(
        input({ stored: { ...stored, historyScanResumePage: 2 } })
      )
    ).toBe(false);
  });
});
