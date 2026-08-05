import { describe, expect, it, vi } from "vitest";

import type { WorkerConfig } from "./config";
import { startHealthServer } from "./health-server";
import { main } from "./main";

const config: WorkerConfig = {
  databaseUrl: "postgres://unused",
  port: 0,
  workerDrainTimeoutMs: 1_000,
  databaseStartupAttempts: 1,
  databaseStartupRetryMs: 1,
  discoveryRequestCap: 12,
  negativeCacheTtlMs: 300_000,
  raiderIoBaseUrl: "https://raider.io",
  raiderIoTimeoutMs: 1_000
};

describe("worker main", () => {
  it("stops an initialized runtime when the health port cannot bind", async () => {
    // Break caught: EADDRINUSE could leak queue/database resources and signal handlers.
    const occupied = await startHealthServer({
      port: 0,
      health: async () => ({ live: true, ready: true })
    });
    const stop = vi.fn(async () => {});
    const sigtermListeners = process.listenerCount("SIGTERM");
    const sigintListeners = process.listenerCount("SIGINT");
    try {
      await expect(
        main({
          loadConfig: () => ({ ...config, port: occupied.port }),
          createLogger: () => ({ info() {} }),
          createRuntime: async () => ({
            health: async () => ({ live: true, ready: true }),
            stop
          }),
          startHealthServer
        })
      ).rejects.toMatchObject({ code: "EADDRINUSE" });

      expect(stop).toHaveBeenCalledOnce();
      expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
      expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
    } finally {
      await occupied.stop();
    }
  });
});
