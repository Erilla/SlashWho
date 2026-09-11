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
      // A deterministic source limitation proves the dossier presents partial
      // evidence rather than hiding unavailable third-party data.
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "fixture_unavailable" }));
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
