import { createServer } from "node:http";

import { listen } from "../../support/listen";

type FakeBlizzard = Readonly<{
  baseUrl: string;
  close(): Promise<void>;
}>;

export async function startFakeBlizzard(): Promise<FakeBlizzard> {
  // Proves a service reached this fake rather than live Blizzard (#654).
  let achievementRequests = 0;
  // Delays achievement reads for the load profiler (#646); 0 otherwise.
  let achievementLatencyMs = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    response.setHeader("content-type", "application/json");

    if (request.method === "GET" && url.pathname === "/__control/stats") {
      response.end(JSON.stringify({ achievementRequests }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/__control/latency") {
      achievementLatencyMs = Math.max(
        0,
        Number(url.searchParams.get("ms")) || 0
      );
      response.end(JSON.stringify({ achievementLatencyMs }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/token") {
      response.end(
        JSON.stringify({ access_token: "e2e-access-token", expires_in: 3600 })
      );
      return;
    }

    if (request.method === "GET" && url.pathname.endsWith("/achievements")) {
      achievementRequests += 1;
      setTimeout(
        () => response.end(JSON.stringify({ achievements: [] })),
        achievementLatencyMs
      );
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
  const port = await listen(server, "fake_blizzard_address_unavailable");
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}
