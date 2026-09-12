import { describe, expect, it } from "vitest";

import { normalizeJournalRaid } from "./raid-catalogue.mts";

describe("Blizzard Journal raid catalogue", () => {
  it("keeps a Mythic raid and preserves the Journal encounter display order", () => {
    expect(
      normalizeJournalRaid({
        id: 1273,
        name: "Nerub-ar Palace",
        category: { type: "RAID" },
        modes: [{ mode: { type: "MYTHIC" } }],
        encounters: [
          { id: 1, name: "First" },
          { id: 2, name: "Last" }
        ]
      })
    ).toEqual({
      journalRaidId: "1273",
      raidName: "Nerub-ar Palace",
      encounters: [
        { journalBossId: "1", bossName: "First", bossOrder: 1 },
        { journalBossId: "2", bossName: "Last", bossOrder: 2 }
      ]
    });
  });

  it("excludes non-raid and non-Mythic Journal instances", () => {
    expect(
      normalizeJournalRaid({
        id: 1,
        name: "Dungeon",
        category: { type: "DUNGEON" },
        modes: [{ mode: { type: "MYTHIC" } }],
        encounters: []
      })
    ).toBeNull();
    expect(
      normalizeJournalRaid({
        id: 2,
        name: "Raid Finder",
        category: { type: "RAID" },
        modes: [{ mode: { type: "LFR" } }],
        encounters: []
      })
    ).toBeNull();
  });
});
