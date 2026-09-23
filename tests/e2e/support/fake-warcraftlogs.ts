import { createServer, type Server } from "node:http";

/** The one character ID the fake knows: Ryii-Silvermoon (EU). */
export const fakeWarcraftLogsCharacterId = 40989140;

type FakeWarcraftLogs = Readonly<{ baseUrl: string; close(): Promise<void> }>;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake_warcraftlogs_address_unavailable");
  }
  return address.port;
}

export async function startFakeWarcraftLogs(): Promise<FakeWarcraftLogs> {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && url.pathname === "/oauth/token") {
      response.end(
        JSON.stringify({ access_token: "e2e-token", expires_in: 3600 })
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v2/client") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        query?: string;
        variables?: { name?: string; realm?: string; id?: number };
      };
      // A pasted character-ID URL resolves to the seeded Ryii; any other ID is
      // absent, as Warcraft Logs answers an unknown one.
      if (body.query?.includes("ResolveCharacterById")) {
        const id = body.variables?.id;
        response.end(
          JSON.stringify({
            data: {
              characterData: {
                character:
                  id === fakeWarcraftLogsCharacterId
                    ? {
                        id,
                        name: "Ryii",
                        server: { slug: "silvermoon", region: { slug: "eu" } }
                      }
                    : null
              }
            }
          })
        );
        return;
      }
      const name = body.variables?.name ?? "fixture";
      const serverName = body.variables?.realm ?? "fixture-realm";
      // Zone rankings are a separate request from the report list. Answering
      // them with a report payload would read as schema drift and put a parse
      // limitation on every seeded dossier.
      if (body.query?.includes("CharacterZoneParses")) {
        const rankings = [
          {
            encounter: { id: 1234, name: "Queen Ansurek" },
            rankPercent: 88.4,
            bestSpec: "Assassination",
            totalKills: 2
          }
        ];
        response.end(
          JSON.stringify({
            data: {
              characterData: {
                character: {
                  damage: { rankings },
                  healing: { rankings: [] },
                  bossDamage: { rankings }
                }
              }
            }
          })
        );
        return;
      }
      response.end(
        JSON.stringify({
          data: {
            characterData: {
              character: {
                server: { normalizedName: serverName },
                recentReports: {
                  data: [
                    {
                      code: "e2eReport",
                      startTime: 1_736_800_000_000,
                      guild: {
                        name: "Arachnid",
                        server: { slug: "silvermoon" }
                      },
                      zone: { id: 42, name: "Nerub-ar Palace" },
                      masterData: {
                        actors: [
                          {
                            id: 7,
                            name,
                            server: serverName,
                            type: "Player"
                          }
                        ]
                      },
                      fights: [
                        {
                          id: 9,
                          encounterID: 1234,
                          name: "Queen Ansurek",
                          startTime: 3_600_000,
                          endTime: 3_900_000,
                          kill: true,
                          difficulty: 5,
                          friendlyPlayers: [7]
                        }
                      ]
                    },
                    {
                      code: "e2eSecondReport",
                      startTime: 1_736_803_600_000,
                      guild: {
                        name: "Arachnid",
                        server: { slug: "silvermoon" }
                      },
                      zone: { id: 42, name: "Nerub-ar Palace" },
                      masterData: {
                        actors: [
                          {
                            id: 7,
                            name,
                            server: serverName,
                            type: "Player"
                          }
                        ]
                      },
                      fights: [
                        {
                          id: 10,
                          encounterID: 1234,
                          name: "Queen Ansurek",
                          startTime: 3_600_000,
                          endTime: 3_900_000,
                          kill: true,
                          difficulty: 5,
                          friendlyPlayers: [7]
                        }
                      ]
                    }
                  ],
                  has_more_pages: false
                }
              }
            }
          }
        })
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ status: 404 }));
  });
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  };
}
