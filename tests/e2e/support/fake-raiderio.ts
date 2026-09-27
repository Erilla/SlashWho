import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";

import { listen } from "../../support/listen";

type FakeRaiderIo = Readonly<{
  baseUrl: string;
  close(): Promise<void>;
}>;

/**
 * Guilds the fake ranks: Arachnid, which the e2e seeds use, and any guild the
 * load profiler (#646) names, so each profiled load can miss the per-guild
 * ranking cache.
 */
function rankedGuild(name: string | null): boolean {
  return name === "Arachnid" || (name?.startsWith("Profile") ?? false);
}

const ryii = {
  name: "Ryii",
  level: 90,
  className: "Warrior",
  realm: "Silvermoon",
  region: "EU"
} as const;

const queuedCharacter = {
  ...ryii,
  name: "Queued"
} as const;

// Searched from the landing page to watch its recent-searches row; declares
// Frostalt so its discovery can be held on that read.
const recentCharacter = {
  ...ryii,
  name: "Recent"
} as const;

// Reached only through a pasted Warcraft Logs character-ID URL, so the
// evidence run its research starts shares no state with Ryii's specs.
const ryun = {
  ...ryii,
  name: "Ryun"
} as const;

const frostalt = {
  name: "Frostalt",
  level: 80,
  className: "Paladin",
  realm: "Silvermoon",
  region: "EU"
} as const;

const nightalt = {
  name: "Nightalt",
  level: 77,
  className: "Druid",
  realm: "Tarren-Mill",
  region: "EU"
} as const;

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

export async function startFakeRaiderIo(): Promise<FakeRaiderIo> {
  // The refreshing state is only observable while an upstream read is still in
  // flight. Hold Queued's declared related-character read so the initial
  // dossier can independently check the root's tournament eligibility.
  let holdingRelatedCharacterRead = false;
  let discoveryWebhooks = 0;
  const characterRequests = new Map<string, number>();
  const held: Array<() => void> = [];
  const releaseAll = () => {
    holdingRelatedCharacterRead = false;
    while (held.length > 0) held.shift()?.();
  };

  // Set by the load profiler (#646) through /__control/latency; every other
  // caller leaves it at 0, so the e2e suite is unaffected.
  let latencyMs = 0;

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (latencyMs > 0 && !url.pathname.startsWith("/__")) {
      setTimeout(() => handle(request, response), latencyMs);
      return;
    }
    handle(request, response);
  });

  function handle(request: IncomingMessage, response: ServerResponse): void {
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
      json(response, 200, { holdingRelatedCharacterRead: false });
      return;
    }

    if (url.pathname === "/__control/latency") {
      latencyMs = Math.max(0, Number(url.searchParams.get("ms")) || 0);
      json(response, 200, { latencyMs });
      return;
    }

    if (url.pathname === "/__control/hold") {
      holdingRelatedCharacterRead = true;
      json(response, 200, { holdingRelatedCharacterRead: true });
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
        !rankedGuild(url.searchParams.get("guild")) ||
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
        !rankedGuild(url.searchParams.get("name")) ||
        url.searchParams.get("fields") !==
          "raid_encounters:nerubar-palace:mythic"
      ) {
        json(response, 404, { status: 404 });
        return;
      }
      json(response, 200, {
        name: url.searchParams.get("name"),
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

    const declaredCharacter = (
      character: Parameters<typeof upstreamCharacter>[0],
      main: { name: string; path: string } | null
    ) =>
      json(response, 200, {
        characterDetails: {
          character: upstreamCharacter(character),
          ...(main ? { characterCustomizations: { main_character: main } } : {})
        }
      });

    if (url.pathname === "/api/characters/eu/silvermoon/ryii") {
      declaredCharacter(ryii, {
        name: frostalt.name,
        path: "/characters/eu/silvermoon/Frostalt"
      });
      return;
    }

    if (url.pathname === "/api/characters/eu/silvermoon/frostalt") {
      const send = () =>
        declaredCharacter(frostalt, {
          name: nightalt.name,
          path: "/characters/eu/tarren-mill/Nightalt"
        });
      if (holdingRelatedCharacterRead) held.push(send);
      else send();
      return;
    }

    if (url.pathname === "/api/characters/eu/tarren-mill/nightalt") {
      declaredCharacter(nightalt, null);
      return;
    }

    if (url.pathname === "/api/characters/eu/silvermoon/ryun") {
      declaredCharacter(ryun, null);
      return;
    }

    // The load profiler's cold reads (#646): a character with nothing
    // declared, so each discovery starts and ends on that character alone.
    const profiled =
      /^\/api\/characters\/eu\/silvermoon\/(profilecold[a-z]*)$/.exec(
        url.pathname
      );
    if (profiled) {
      const name = profiled[1]!;
      declaredCharacter(
        { ...ryii, name: name.charAt(0).toUpperCase() + name.slice(1) },
        null
      );
      return;
    }

    if (url.pathname === "/api/characters/eu/silvermoon/queued") {
      declaredCharacter(queuedCharacter, {
        name: frostalt.name,
        path: "/characters/eu/silvermoon/Frostalt"
      });
      return;
    }

    if (url.pathname === "/api/characters/eu/silvermoon/recent") {
      declaredCharacter(recentCharacter, {
        name: frostalt.name,
        path: "/characters/eu/silvermoon/Frostalt"
      });
      return;
    }

    if (url.pathname.endsWith("/raid-progress")) {
      json(response, 200, {
        characterRaidProgress: {
          raidProgress: [
            {
              raid: "nerubar-palace",
              encountersDefeated: {
                normal: [],
                heroic: [],
                mythic: [
                  {
                    slug: "queen-ansurek",
                    firstDefeated: "2025-01-14T20:30:00.000Z",
                    guild: {
                      name: "Arachnid",
                      realm: { slug: "silvermoon" },
                      region: { slug: "eu" }
                    }
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
  }

  const port = await listen(server, "fake_raiderio_address_unavailable");
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        releaseAll();
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}
