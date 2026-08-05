import { createServer } from "node:http";

export type WorkerHealth = {
  live: boolean;
  ready: boolean;
};

export type HealthServerOptions = {
  port: number;
  host?: string;
  health: () => Promise<WorkerHealth>;
};

export type HealthServer = {
  port: number;
  stop(): Promise<void>;
};

function json(
  response: import("node:http").ServerResponse,
  status: number,
  body: object
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export async function startHealthServer(
  options: HealthServerOptions
): Promise<HealthServer> {
  const server = createServer(async (request, response) => {
    if (request.method !== "GET") {
      json(response, 404, { status: "not_found" });
      return;
    }
    if (request.url === "/health") {
      json(response, 200, { status: "ok" });
      return;
    }
    if (request.url === "/ready") {
      try {
        const health = await options.health();
        json(
          response,
          health.ready ? 200 : 503,
          health.ready ? { status: "ready" } : { status: "not_ready" }
        );
      } catch {
        json(response, 503, { status: "not_ready" });
      }
      return;
    }
    json(response, 404, { status: "not_found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("health_server_address_unavailable");
  }

  return {
    port: address.port,
    async stop() {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}
