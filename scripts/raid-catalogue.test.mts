import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";

import {
  fetchJournalRaids,
  isDirectExecution,
  normalizeJournalRaid
} from "./raid-catalogue.mts";

describe("Blizzard Journal raid catalogue", () => {
  it("recognizes a direct TypeScript script invocation", () => {
    const script = "C:/workspace/scripts/generate-raid-catalogue.mts";
    expect(isDirectExecution(pathToFileURL(script).href, script)).toBe(true);
  });

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
      imageUrl: null,
      encounters: [
        { journalBossId: "1", bossName: "First", bossOrder: 1, imageUrl: null },
        { journalBossId: "2", bossName: "Last", bossOrder: 2, imageUrl: null }
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
    const urls: URL[] = [];
    const fetch = async (input: string | URL) => {
      const url = new URL(String(input));
      urls.push(url);
      const path = url.pathname;
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
            : path === "/data/wow/media/journal-instance/1273"
              ? {
                  assets: [
                    {
                      key: "tile",
                      value: "https://render.example/raids/nerub-ar.jpg"
                    }
                  ]
                }
              : path === "/data/wow/journal-encounter/1"
                ? {
                    creatures: [
                      {
                        name: "First",
                        creature_display: { id: 9001 }
                      }
                    ]
                  }
                : path === "/data/wow/media/creature-display/9001"
                  ? {
                      assets: [
                        {
                          key: "zoom",
                          value: "https://render.example/bosses/first.jpg"
                        }
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
        imageUrl: "https://render.example/raids/nerub-ar.jpg",
        encounters: [
          {
            journalBossId: "1",
            bossName: "First",
            bossOrder: 1,
            imageUrl: "https://render.example/bosses/first.jpg"
          }
        ]
      }
    ]);
    expect(urls[0]?.searchParams.get("namespace")).toBe("static-eu");
    expect(urls[0]?.searchParams.get("locale")).toBe("en_GB");
  });
});
