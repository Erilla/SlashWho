import { describe, expect, it } from "vitest";

import { fetchJournalRaids, normalizeJournalRaid } from "./raid-catalogue.mts";

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

  it("walks Journal tiers and deduplicates Mythic raid instances", async () => {
    const fetch = async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      const body =
        path === "/data/wow/journal-expansion/index"
          ? { tiers: [{ key: { href: "https://api.example/tier/1" } }] }
          : path === "/tier/1"
            ? {
                raids: [
                  { key: { href: "https://api.example/raid/1273" } },
                  { key: { href: "https://api.example/raid/1273" } },
                  { key: { href: "https://api.example/raid/9" } }
                ]
              }
            : path === "/raid/1273"
              ? {
                  id: 1273,
                  name: "Nerub-ar Palace",
                  category: { type: "RAID" },
                  modes: [{ mode: { type: "MYTHIC" } }],
                  encounters: [{ id: 1, name: "First" }]
                }
              : {
                  id: 9,
                  name: "Dungeon",
                  category: { type: "DUNGEON" },
                  modes: [{ mode: { type: "MYTHIC" } }],
                  encounters: []
                };
      return Response.json(body);
    };

    await expect(
      fetchJournalRaids({
        fetch: fetch as typeof globalThis.fetch,
        accessToken: "token",
        baseUrl: new URL("https://api.example")
      })
    ).resolves.toEqual([
      {
        journalRaidId: "1273",
        raidName: "Nerub-ar Palace",
        encounters: [{ journalBossId: "1", bossName: "First", bossOrder: 1 }]
      }
    ]);
  });
});
