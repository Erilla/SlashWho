import { createServer, type Server } from "node:http";

type FakeRaiderIo = Readonly<{
  baseUrl: string;
  close(): Promise<void>;
}>;

const ownerCharacters = [
  {
    name: "Ryii",
    level: 80,
    className: "Mage",
    realm: "Silvermoon",
    region: "EU"
  },
  {
    name: "Frostalt",
    level: 80,
    className: "Paladin",
    realm: "Silvermoon",
    region: "EU"
  },
  {
    name: "Nightalt",
    level: 77,
    className: "Druid",
    realm: "Tarren-Mill",
    region: "EU"
  }
] as const;

function upstreamCharacter(
  character: Readonly<{
    name: string;
    level: number;
    className: string;
    realm: string;
    region: string;
  }>
) {
  return {
    name: character.name,
    level: character.level,
    class: { name: character.className },
    realm: { slug: character.realm },
    region: { slug: character.region }
  };
}

function json(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown
) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fake_raiderio_address_unavailable");
  return address.port;
}

export async function startFakeRaiderIo(): Promise<FakeRaiderIo> {
  // The refreshing state is only observable while an upstream read is still in
  // flight. Hold the owner list so discovery stays pending while the initial
  // dossier can independently check the root's tournament eligibility.
  let released = false;
  let discoveryWebhooks = 0;
  const characterRequests = new Map<string, number>();
  const held: Array<() => void> = [];
  const releaseAll = () => {
    released = true;
    while (held.length > 0) held.shift()?.();
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (request.method === "POST" && url.pathname === "/__webhook/discovery") {
      discoveryWebhooks += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== "GET") {
      json(response, 405, { status: 405 });
      return;
    }

    if (url.pathname === "/__control/reset-stats") {
      discoveryWebhooks = 0;
      characterRequests.clear();
      json(response, 200, { reset: true });
      return;
    }

    if (url.pathname === "/__control/stats") {
      json(response, 200, {
        discoveryWebhooks,
        characterRequests: Object.fromEntries(characterRequests)
      });
      return;
    }

    if (url.pathname === "/__control/release") {
      releaseAll();
      json(response, 200, { released: true });
      return;
    }

    if (url.pathname === "/__control/hold") {
      released = false;
      json(response, 200, { released: false });
      return;
    }

    if (url.pathname === "/api/v1/raiding/boss-rankings") {
      if (
        url.searchParams.get("raid") !== "nerubar-palace" ||
        url.searchParams.get("boss") !== "queen-ansurek" ||
        url.searchParams.get("difficulty") !== "mythic" ||
        url.searchParams.get("region") !== "world"
      ) {
        json(response, 404, { status: 404 });
        return;
      }
      json(response, 200, {
        bossRankings: [
          {
            rank: 147,
            guild: {
              name: "Arachnid",
              realm: { slug: "silvermoon" },
              region: { slug: "eu" }
            },
            encountersDefeated: {
              firstDefeated: "2025-01-13T21:31:40.000Z"
            }
          }
        ]
      });
      return;
    }

    if (url.pathname === "/api/guilds/raid-rankings") {
      if (
        url.searchParams.get("region") !== "eu" ||
        url.searchParams.get("realm") !== "silvermoon" ||
        url.searchParams.get("guild") !== "Arachnid" ||
        url.searchParams.get("raid") !== "nerubar-palace" ||
        url.searchParams.get("difficulty") !== "mythic"
      ) {
        json(response, 404, { status: 404 });
        return;
      }
      json(response, 200, {
        bossRankings: [{ boss: "queen-ansurek", ranks: { world: 147 } }]
      });
      return;
    }

    if (url.pathname === "/api/v1/guilds/profile") {
      if (
        url.searchParams.get("region") !== "eu" ||
        url.searchParams.get("realm") !== "silvermoon" ||
        url.searchParams.get("name") !== "Arachnid" ||
        url.searchParams.get("fields") !==
          "raid_encounters:nerubar-palace:mythic"
      ) {
        json(response, 404, { status: 404 });
        return;
      }
      json(response, 200, {
        name: "Arachnid",
        realm: "silvermoon",
        region: "eu",
        raid_encounters: [
          {
            slug: "queen-ansurek",
            defeatedAt: "2025-01-13T21:31:40.000Z"
          }
        ]
      });
      return;
    }

    if (url.pathname.startsWith("/api/characters/")) {
      characterRequests.set(
        url.pathname,
        (characterRequests.get(url.pathname) ?? 0) + 1
      );
    }

    if (
      url.pathname === "/api/characters/eu/silvermoon/ryii" ||
      url.pathname === "/api/characters/eu/silvermoon/queued"
    ) {
      const queued = url.pathname.endsWith("/queued");
      const send = () =>
        json(response, 200, {
          characterDetails: {
            character: upstreamCharacter(
              queued
                ? { ...ownerCharacters[0], name: "Queued" }
                : ownerCharacters[0]
            ),
            user: { name: "fixture-owner" },
            characterCustomizations: {
              discord_profile: null,
              main_character: null
            }
          }
        });
      send();
      return;
    }

    if (
      url.pathname === "/api/user/view-characters" &&
      url.searchParams.get("name") === "fixture-owner"
    ) {
      const send = () =>
        json(response, 200, {
          viewUserCharactersApi: {
            name: "fixture-owner",
            characters: ownerCharacters.map((character) => ({
              character: upstreamCharacter(character)
            }))
          }
        });
      if (released) send();
      else held.push(send);
      return;
    }

    if (url.pathname.endsWith("/raid-progress")) {
      json(response, 200, {
        characterRaidProgress: {
          raidProgress: [
            {
              raid: { id: "nerub-ar-palace", name: "Nerub-ar Palace" },
              encountersDefeated: {
                mythic: [
                  {
                    slug: "queen-ansurek",
                    name: "Queen Ansurek",
                    ordinal: 8,
                    isFinalBoss: true,
                    firstDefeated: "2025-01-14T20:30:00.000Z",
                    guild: { name: "Arachnid", realm: { slug: "Silvermoon" } },
                    historicWorldRank: 147
                  }
                ]
              }
            }
          ]
        }
      });
      return;
    }

    json(response, 404, { status: 404 });
  });

  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        releaseAll();
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}
