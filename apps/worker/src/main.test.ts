import { EventEmitter } from "node:events";

import { DiscoveryQueueStopTimeoutError } from "@slashwho/database";
import { describe, expect, it, vi } from "vitest";

import type { WorkerConfig } from "./config";
import { startHealthServer } from "./health-server";
import { main, startWorker } from "./main";

const config: WorkerConfig = {
  applicantWatcher: {
    enabled: false,
    column: "F",
    cadenceMs: 300_000,
    perTick: 1,
    perDay: 5,
    backlog: 100,
    queueDepth: 10,
    minimumPoints: 3500
  },
  databaseUrl: "postgres://unused",
  healthHost: "127.0.0.1",
  port: 0,
  workerDrainTimeoutMs: 1_000,
  workerAbortGraceMs: 200,
  databaseStartupAttempts: 1,
  databaseStartupRetryMs: 1,
  discoveryRequestCap: 12,
  negativeCacheTtlMs: 300_000,
  raiderIoBaseUrl: "https://raider.io",
  raiderIoTimeoutMs: 1_000,
  blizzardClientId: "worker-client-id",
  blizzardClientSecret: "worker-client-secret",
  warcraftLogsClientId: "warcraft-logs-client-id",
  warcraftLogsClientSecret: "warcraft-logs-client-secret",
  evidenceRequestCap: 500,
  evidenceCapRetryMs: 1_800_000,
  evidenceTransientRetryMs: 900_000,
  evidenceResumeSweepLimit: 25,
  evidenceFreshnessHours: 24,
  evidencePointsReserve: 1_500,
  evidenceKillSettleDays: 7,
  evidenceRetryCostCeiling: 250,
  evidenceFailureCooldownMs: 1_800_000,
  evidenceParseRequestCap: 8,
  evidenceTierSearchRequestCap: 60,
  blizzardSweepRequestCap: 300,
  blizzardHourlyRequestBudget: 28_800,
  fingerprintMinimumCommon: 200,
  fingerprintMinimumIdenticalPercent: 20,
  fingerprintSweepCadenceHours: 168,
  evidenceJobCredentialEncryptionKey: Buffer.alloc(32, "a")
};

describe("worker main", () => {
  it("stops an initialized runtime when the health port cannot bind", async () => {
    // Break caught: EADDRINUSE could leak queue/database resources and signal handlers.
    const occupied = await startHealthServer({
      port: 0,
      health: async () => ({ live: true, ready: true }),
      probe: async () => ({
        ready: true,
        lastSuccessfulRunAgeMs: null,
        queueDepth: 0
      })
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
            probe: async () => ({
              ready: true,
              lastSuccessfulRunAgeMs: null,
              queueDepth: 0
            }),
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
          probe: async () => ({
            ready: true,
            lastSuccessfulRunAgeMs: null,
            queueDepth: 0
          }),
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
        probe: async () => ({
          ready: true,
          lastSuccessfulRunAgeMs: null,
          queueDepth: 0
        }),
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

  it("logs a startup failure by error class and exits non-zero", async () => {
    // Break caught: a crash-looping deploy logged no reason for the failure.
    class DatabaseStartupError extends Error {}
    const info = vi.fn();
    const target = Object.assign(new EventEmitter(), {
      exitCode: undefined as number | undefined
    });

    await startWorker(
      {
        loadConfig: () => config,
        createLogger: () => ({ info }),
        createRuntime: async () => {
          throw new DatabaseStartupError("postgres://user:secret@host/db");
        },
        startHealthServer,
        terminate() {}
      },
      target
    );

    expect(info).toHaveBeenCalledExactlyOnceWith({
      event: "worker_start_failed",
      errorName: "DatabaseStartupError"
    });
    expect(target.exitCode).toBe(1);
    expect(target.listenerCount("uncaughtException")).toBe(1);
    expect(target.listenerCount("unhandledRejection")).toBe(1);
  });

  it("logs a config failure, which happens before the runtime exists", async () => {
    // Break caught: a logger created after loadConfig cannot report its failure.
    const info = vi.fn();
    const target = Object.assign(new EventEmitter(), {
      exitCode: undefined as number | undefined
    });

    await startWorker(
      {
        loadConfig: () => {
          throw new TypeError("DATABASE_URL is missing");
        },
        createLogger: () => ({ info }),
        createRuntime: async () => {
          throw new Error("unreachable");
        },
        startHealthServer,
        terminate() {}
      },
      target
    );

    expect(info).toHaveBeenCalledExactlyOnceWith({
      event: "worker_start_failed",
      errorName: "TypeError"
    });
    expect(target.exitCode).toBe(1);
  });
});
