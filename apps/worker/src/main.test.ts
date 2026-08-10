import { DiscoveryQueueStopTimeoutError } from "@slashwho/database";
import { describe, expect, it, vi } from "vitest";

import type { WorkerConfig } from "./config";
import { startHealthServer } from "./health-server";
import { main } from "./main";

const config: WorkerConfig = {
  databaseUrl: "postgres://unused",
  healthHost: "127.0.0.1",
  port: 0,
  workerDrainTimeoutMs: 1_000,
  databaseStartupAttempts: 1,
  databaseStartupRetryMs: 1,
  discoveryRequestCap: 12,
  negativeCacheTtlMs: 300_000,
  raiderIoBaseUrl: "https://raider.io",
  raiderIoTimeoutMs: 1_000,
  blizzardClientId: "worker-client-id",
  blizzardClientSecret: "worker-client-secret",
  blizzardSweepRequestCap: 300,
  blizzardHourlyRequestBudget: 28_800,
  fingerprintMinimumCommon: 200,
  fingerprintMinimumIdenticalPercent: 20,
  fingerprintSweepCadenceHours: 168
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
          startHealthServer,
          terminate() {}
        })
      ).rejects.toMatchObject({ code: "EADDRINUSE" });

      expect(stop).toHaveBeenCalledOnce();
      expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
      expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
    } finally {
      await occupied.stop();
    }
  });

  it("requests termination once when health-bind cleanup times out", async () => {
    // Break caught: failed-start cleanup could suppress a non-cooperative stop timeout.
    const bindError = Object.assign(new Error("health bind failed"), {
      code: "EADDRINUSE"
    });
    const terminate = vi.fn();

    await expect(
      main({
        loadConfig: () => config,
        createLogger: () => ({ info() {} }),
        createRuntime: async () => ({
          health: async () => ({ live: true, ready: true }),
          stop: async () => {
            throw new DiscoveryQueueStopTimeoutError();
          }
        }),
        startHealthServer: async () => {
          throw bindError;
        },
        terminate
      })
    ).rejects.toBe(bindError);

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith(1);
  });

  it("consumes a signal-stop rejection and requests non-graceful termination", async () => {
    // Break caught: voiding a rejected stop promise could emit unhandledRejection.
    const existing = new Set(process.listeners("SIGTERM"));
    let terminated!: () => void;
    const terminationRequested = new Promise<void>((resolve) => {
      terminated = resolve;
    });
    const terminate = vi.fn(() => terminated());
    let onUnhandled!: () => void;
    const unhandled = new Promise<"unhandled">((resolve) => {
      onUnhandled = () => resolve("unhandled");
      process.once("unhandledRejection", onUnhandled);
    });
    await main({
      loadConfig: () => config,
      createLogger: () => ({ info() {} }),
      createRuntime: async () => ({
        health: async () => ({ live: true, ready: true }),
        stop: async () => {
          throw Object.assign(new Error("queue settlement timed out"), {
            code: "discovery_queue_stop_timeout"
          });
        }
      }),
      startHealthServer: async () => ({ port: 3001, async stop() {} }),
      terminate
    });
    const listener = process
      .listeners("SIGTERM")
      .find((candidate) => !existing.has(candidate));
    expect(listener).toBeTypeOf("function");

    try {
      listener!("SIGTERM");
      const outcome = await Promise.race([
        terminationRequested.then(() => "terminated" as const),
        unhandled
      ]);
      expect(outcome).toBe("terminated");
      expect(terminate).toHaveBeenCalledWith(1);
    } finally {
      process.removeListener("SIGTERM", listener!);
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});
