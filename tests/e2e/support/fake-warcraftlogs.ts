import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";

import { listen } from "../../support/listen";

/**
 * The one character ID the fake knows: Ryun-Silvermoon (EU), a character no
 * other spec researches, so the evidence run it starts shares no state.
 */
export const fakeWarcraftLogsCharacterId = 40989140;

type FakeWarcraftLogs = Readonly<{ baseUrl: string; close(): Promise<void> }>;

export async function startFakeWarcraftLogs(): Promise<FakeWarcraftLogs> {
  // GraphQL requests per character name. Proves the worker's evidence run
  // reached this fake rather than live Warcraft Logs; keyed by name so a test
  // counts only its own character's run.
  const characterRequests: Record<string, number> = {};
  let lastHistory = { name: "fixture", serverName: "fixture-realm" };
  const handle = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && url.pathname === "/__control/stats") {
      response.end(JSON.stringify({ characterRequests }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/oauth/token") {
      response.end(
        JSON.stringify({ access_token: "e2e-token", expires_in: 3600 })
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v2/client") {
      const chunks: Buffer[] = [];
      for await (const chunk of request as AsyncIterable<Buffer>)
        chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        query?: string;
        variables?: { name?: string; realm?: string; id?: number };
      };
      const requested = body.variables?.name?.toLowerCase();
      if (requested)
        characterRequests[requested] = (characterRequests[requested] ?? 0) + 1;
      // A pasted character-ID URL resolves to Ryun; any other ID is
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
                        name: "Ryun",
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
      // A history page carries no actors; the scan asks for those of its
      // Mythic reports in one follow-up, one alias a report (#712). The
      // follow-up names no character, so it answers for the character whose
      // page came last: the worker runs one evidence job at a time.
      if (body.query?.includes("query ReportActors")) {
        const reportData = Object.fromEntries(
          Object.entries(body.variables ?? {}).map(([alias, code]) => [
            alias.replace(/^code/, "report"),
            {
              code,
              masterData: {
                actors: [
                  {
                    id: 7,
                    name: lastHistory.name,
                    server: lastHistory.serverName,
                    type: "Player"
                  }
                ]
              }
            }
          ])
        );
        response.end(JSON.stringify({ data: { reportData } }));
        return;
      }
      if (body.query?.includes("query RecentReports")) {
        lastHistory = { name, serverName };
      }
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
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  const port = await listen(server, "fake_warcraftlogs_address_unavailable");
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  };
}
