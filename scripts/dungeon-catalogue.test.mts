import { describe, expect, it } from "vitest";

import {
  fetchJournalDungeons,
  normalizeJournalDungeon
} from "./dungeon-catalogue.mts";

function tierResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("Blizzard Journal dungeon catalogue", () => {
  it("keeps a dungeon's id and name", () => {
    expect(
      normalizeJournalDungeon({ id: 2290, name: "Mists of Tirna Scithe" })
    ).toEqual({
      journalDungeonId: "2290",
      dungeonName: "Mists of Tirna Scithe"
    });
  });

  it("rejects a dungeon with no usable id or name", () => {
    expect(normalizeJournalDungeon({ id: 0, name: "Nameless" })).toBeNull();
    expect(normalizeJournalDungeon({ id: 1, name: "   " })).toBeNull();
    expect(normalizeJournalDungeon(null)).toBeNull();
  });

  it("collects every expansion's dungeons, deduplicated and ordered", async () => {
    const fetch = (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/journal-expansion/index")) {
        return tierResponse({
          tiers: [
            { key: { href: "https://eu.api.blizzard.com/x/1" } },
            { key: { href: "https://eu.api.blizzard.com/x/2" } }
          ]
        });
      }
      return tierResponse(
        url.pathname === "/x/1"
          ? {
              dungeons: [
                { id: 2290, name: "Mists of Tirna Scithe" },
                { id: 2286, name: "The Necrotic Wake" }
              ]
            }
          : {
              // Repeated across expansions upstream; one entry is expected.
              dungeons: [
                { id: 2286, name: "The Necrotic Wake" },
                { id: 1493, name: "Vault of the Wardens" }
              ]
            }
      );
    }) as typeof globalThis.fetch;

    await expect(
      fetchJournalDungeons({
        fetch,
        accessToken: "token",
        baseUrl: new URL("https://eu.api.blizzard.com")
      })
    ).resolves.toEqual([
      { journalDungeonId: "1493", dungeonName: "Vault of the Wardens" },
      { journalDungeonId: "2286", dungeonName: "The Necrotic Wake" },
      { journalDungeonId: "2290", dungeonName: "Mists of Tirna Scithe" }
    ]);
  });

  it("fails rather than publishing a catalogue with a tier missing", async () => {
    // A silently short catalogue is the dangerous outcome: a dungeon it does
    // not name is a dungeon that keeps pinning the scan floor, and nothing
    // says so.
    const fetch = (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      return tierResponse(
        url.pathname.endsWith("/journal-expansion/index")
          ? { tiers: [{ key: { href: "https://eu.api.blizzard.com/x/1" } }] }
          : { raids: [] }
      );
    }) as typeof globalThis.fetch;

    await expect(
      fetchJournalDungeons({
        fetch,
        accessToken: "token",
        baseUrl: new URL("https://eu.api.blizzard.com")
      })
    ).rejects.toThrow("journal_dungeons_invalid");
  });
});
