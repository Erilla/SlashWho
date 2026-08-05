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

function upstreamCharacter(character: (typeof ownerCharacters)[number]) {
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
  // flight. Holding the root character response until the test releases it makes
  // that window deterministic instead of dependent on render timing.
  let released = false;
  const held: Array<() => void> = [];
  const releaseAll = () => {
    released = true;
    while (held.length > 0) held.shift()?.();
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (request.method !== "GET") {
      json(response, 405, { status: 405 });
      return;
    }

    if (url.pathname === "/__control/release") {
      releaseAll();
      json(response, 200, { released: true });
      return;
    }

    if (url.pathname === "/api/characters/eu/silvermoon/ryii") {
      const send = () =>
        json(response, 200, {
          characterDetails: {
            character: upstreamCharacter(ownerCharacters[0]),
            user: { name: "fixture-owner" },
            characterCustomizations: {
              discord_profile: null,
              main_character: null
            }
          }
        });
      if (released) send();
      else held.push(send);
      return;
    }

    if (
      url.pathname === "/api/user/view-characters" &&
      url.searchParams.get("name") === "fixture-owner"
    ) {
      json(response, 200, {
        viewUserCharactersApi: {
          name: "fixture-owner",
          characters: ownerCharacters.map((character) => ({
            character: upstreamCharacter(character)
          }))
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
