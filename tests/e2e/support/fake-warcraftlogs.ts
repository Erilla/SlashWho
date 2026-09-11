import { createServer, type Server } from "node:http";

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
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && url.pathname === "/oauth/token") {
      response.end(
        JSON.stringify({ access_token: "e2e-token", expires_in: 3600 })
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v2/client") {
      response.end(
        JSON.stringify({
          data: {
            characterData: {
              character: {
                recentReports: {
                  data: [
                    {
                      code: "e2eReport",
                      startTime: 1_736_800_000_000,
                      zone: { id: 42, name: "Nerub-ar Palace" },
                      masterData: {
                        actors: [
                          {
                            id: 7,
                            name: "Ryii",
                            server: "Silvermoon",
                            type: "Mage"
                          }
                        ]
                      },
                      fights: [
                        {
                          id: 9,
                          encounterID: 1234,
                          name: "Queen Ansurek",
                          startTime: 3_600_000,
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
