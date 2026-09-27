import {
  lookupCuttingEdgeAchievement,
  lookupRaidForEvidence
} from "@slashwho/domain";
import { describe, expect, it } from "vitest";

import {
  syntheticEvidence,
  syntheticEvidenceCutoff
} from "./synthetic-evidence";

const volume = { kills: 76, wipes: 161, tierBests: 2, cuttingEdges: 6 };

describe("syntheticEvidence", () => {
  it("generates exactly the requested volume", () => {
    const evidence = syntheticEvidence("alpha", volume);

    expect(evidence.kills).toHaveLength(76);
    expect(evidence.wipes).toHaveLength(161);
    expect(evidence.tierBests).toHaveLength(2);
    expect(evidence.cuttingEdges).toHaveLength(6);
  });

  it("generates nothing for an empty volume", () => {
    expect(
      syntheticEvidence("alpha", {
        kills: 0,
        wipes: 0,
        tierBests: 0,
        cuttingEdges: 0
      })
    ).toEqual({ kills: [], wipes: [], tierBests: [], cuttingEdges: [] });
  });

  it("keeps every stored key unique, as the tables require", () => {
    const evidence = syntheticEvidence("alpha", {
      kills: 3_000,
      wipes: 13_000,
      tierBests: 70,
      cuttingEdges: 19
    });

    const unique = (values: readonly string[]) => new Set(values).size;
    expect(unique(evidence.kills.map((kill) => kill.fightUrl))).toBe(3_000);
    expect(unique(evidence.wipes.map((wipe) => wipe.fightUrl))).toBe(13_000);
    expect(
      unique(evidence.tierBests.map((best) => `${best.raidId}:${best.bossId}`))
    ).toBe(70);
    expect(
      unique(evidence.cuttingEdges.map((edge) => edge.achievementId))
    ).toBe(19);
  });

  it("keeps two characters' reports apart", () => {
    const first = syntheticEvidence("alpha", volume);
    const second = syntheticEvidence("bravo", volume);

    const reports = new Set(first.kills.map((kill) => kill.reportUrl));
    expect(second.kills.some((kill) => reports.has(kill.reportUrl))).toBe(
      false
    );
  });

  it("places every kill, wipe and tier best in a catalogued raid", () => {
    const evidence = syntheticEvidence("alpha", volume);

    for (const row of [
      ...evidence.kills,
      ...evidence.wipes,
      ...evidence.tierBests
    ]) {
      expect(
        lookupRaidForEvidence({
          raidName: row.raidName,
          bossName: row.bossName,
          journalBossId: row.bossId
        })?.raidName
      ).toBe(row.raidName);
    }
    for (const edge of evidence.cuttingEdges) {
      expect(lookupCuttingEdgeAchievement(edge.achievementId)).not.toBeNull();
    }
  });

  it("dates every kill and wipe in the past, whatever the calendar says", () => {
    const evidence = syntheticEvidence("alpha", {
      ...volume,
      kills: 3_000,
      wipes: 13_000
    });

    const latest = Math.max(
      ...evidence.kills.map((kill) => Date.parse(kill.killedAt)),
      ...evidence.wipes.map((wipe) => Date.parse(wipe.attemptedAt))
    );
    expect(latest).toBeLessThanOrEqual(Date.parse(syntheticEvidenceCutoff));
  });

  it("marks every kill's rank as looked up, so a warm read makes no lookup", () => {
    const { kills } = syntheticEvidence("alpha", volume);

    expect(
      kills.every(
        (kill) =>
          kill.historicWorldRank !== null || kill.historicRankCheckedAt !== null
      )
    ).toBe(true);
  });

  it("gives about four in five kills their parses, as production does", () => {
    const { kills } = syntheticEvidence("alpha", { ...volume, kills: 1_000 });

    const parsed = kills.filter(
      (kill) => kill.performance.damage.state === "available"
    ).length;
    expect(parsed).toBe(800);
  });
});
