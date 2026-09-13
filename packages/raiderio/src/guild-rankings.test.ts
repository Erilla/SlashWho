import { expect, it } from "vitest";
import { createRaiderIoClient } from "./client";

// Minimized from Rancour's public website and guild-profile responses.
const ranks = {
  bossRankings: [
    { boss: "sszorak", ranks: { world: 276, region: 158 } },
    { boss: "entombed-sentinels", ranks: { world: 297 } },
    { boss: "the-twin-fangs", ranks: { world: 346 } }
  ]
};
const profile = {
  name: "Rancour",
  realm: "Draenor",
  region: "eu",
  raid_encounters: [
    { slug: "sszorak", defeatedAt: "2026-09-07T18:42:21Z" },
    { slug: "entombed-sentinels", defeatedAt: "2026-08-31T20:30:01Z" }
  ]
};
const options = {
  raidSlug: "the-venomous-abyss",
  bossSlug: "sszorak",
  guild: { name: "Rancour", realm: "draenor", region: "eu" }
};

it("loads guild boss world ranks beyond 50 and excludes undefeated attempts", async () => {
  const urls: URL[] = [];
  const client = createRaiderIoClient({
    baseUrl: "https://raider.io",
    timeoutMs: 1000,
    fetch: async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      return Response.json(
        url.pathname === "/api/guilds/raid-rankings" ? ranks : profile
      );
    }
  });
  expect(await client.getMythicBossRankings(options)).toEqual({
    kind: "rankings",
    rows: [
      {
        bossSlug: "sszorak",
        rank: 276,
        guildName: "Rancour",
        guildRealm: "Draenor",
        guildRegion: "eu",
        firstDefeated: "2026-09-07T18:42:21Z"
      },
      {
        bossSlug: "entombed-sentinels",
        rank: 297,
        guildName: "Rancour",
        guildRealm: "Draenor",
        guildRegion: "eu",
        firstDefeated: "2026-08-31T20:30:01Z"
      }
    ]
  });
  expect(urls.map((url) => url.pathname).sort()).toEqual([
    "/api/guilds/raid-rankings",
    "/api/v1/guilds/profile"
  ]);
  expect(
    urls
      .find((url) => url.pathname.endsWith("profile"))
      ?.searchParams.get("fields")
  ).toBe("raid_encounters:the-venomous-abyss:mythic");
});

it("preserves schema drift as a limitation", async () => {
  const client = createRaiderIoClient({
    baseUrl: "https://raider.io",
    timeoutMs: 1000,
    fetch: async () => Response.json({})
  });
  expect(await client.getMythicBossRankings(options)).toEqual({
    kind: "limitation",
    code: "schema_drift"
  });
});
