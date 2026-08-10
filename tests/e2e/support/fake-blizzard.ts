import { createServer, type Server } from "node:http";

type FakeBlizzard = Readonly<{
  baseUrl: string;
  close(): Promise<void>;
}>;

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
    throw new Error("fake_blizzard_address_unavailable");
  }
  return address.port;
}

export async function startFakeBlizzard(): Promise<FakeBlizzard> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    response.setHeader("content-type", "application/json");

    if (request.method === "POST" && url.pathname === "/token") {
      response.end(
        JSON.stringify({ access_token: "e2e-access-token", expires_in: 3600 })
      );
      return;
    }

    if (request.method === "GET" && url.pathname.endsWith("/achievements")) {
      response.end(JSON.stringify({ achievements: [] }));
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname.startsWith("/profile/wow/character/")
    ) {
      // No guild means the sweep only fingerprints its root character.
      response.end(JSON.stringify({}));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ status: 404 }));
  });
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}
