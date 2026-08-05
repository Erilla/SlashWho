import type {
  DiscoveryJobHandler,
  DiscoveryJobHandlerOptions
} from "@slashwho/application";
import { DiscoveryQueueStopTimeoutError } from "@slashwho/database";
import type {
  DiscoverCharacterJob,
  DiscoveryQueue,
  DiscoveryWorkContext,
  Repositories
} from "@slashwho/database";
import type { RaiderIoGateway } from "@slashwho/domain";
import { describe, expect, it, vi } from "vitest";

import type { WorkerConfig } from "./config";
import { createWorkerRuntime } from "./runtime";

const config: WorkerConfig = {
  databaseUrl: "postgres://worker:secret@database/slashwho",
  healthHost: "127.0.0.1",
  port: 3001,
  workerDrainTimeoutMs: 12_345,
  databaseStartupAttempts: 3,
  databaseStartupRetryMs: 10,
  discoveryRequestCap: 12,
  negativeCacheTtlMs: 300_000,
  raiderIoBaseUrl: "https://raider.io",
  raiderIoTimeoutMs: 5_000
};

function runtimeFakes() {
  let connectionAttempts = 0;
  let ended = false;
  let queueReady = false;
  let workHandler:
    | ((
        payload: DiscoverCharacterJob,
        context: DiscoveryWorkContext
      ) => Promise<void>)
    | undefined;
  let maintenanceHandler: (() => Promise<void>) | undefined;
  const pendingDispatches: DiscoverCharacterJob[] = [];
  const recoveredDispatches: string[] = [];
  const enqueued: DiscoverCharacterJob[] = [];
  const queue: DiscoveryQueue = {
    async start() {
      queueReady = true;
    },
    async enqueue(payload) {
      enqueued.push(payload);
      return payload.runId;
    },
    async work(handler) {
      workHandler = handler;
    },
    async scheduleMaintenanceCleanup(handler) {
      maintenanceHandler = handler;
    },
    async stop() {
      queueReady = false;
    },
    isReady() {
      return queueReady;
    }
  };
  const handler: DiscoveryJobHandler = { execute: vi.fn(async () => {}) };
  const pool = {
    async query() {
      connectionAttempts += 1;
      if (connectionAttempts < 3) throw new Error("database_starting");
      return { rows: [{ "?column?": 1 }] };
    },
    async end() {
      ended = true;
    }
  };
  const migrations = vi.fn(async () => {});
  const cleanup = {
    rateLimits: vi.fn(async () => 2),
    negativeCache: vi.fn(async () => 3),
    suppressions: vi.fn(async () => 4)
  };
  const repositories = {
    searchReservations: {
      async listPending() {
        return [...pendingDispatches];
      },
      async markEnqueued(runId: string) {
        recoveredDispatches.push(runId);
      }
    },
    rateLimits: { cleanupExpired: cleanup.rateLimits },
    negativeCache: { cleanupExpired: cleanup.negativeCache },
    suppressions: { cleanupExpired: cleanup.suppressions }
  } as unknown as Repositories;
  const sleeps: number[] = [];

  return {
    dependencies: {
      createPool: () => pool,
      runMigrations: migrations,
      createRepositories: () => repositories,
      createQueue: () => queue,
      createGateway: () => ({}) as RaiderIoGateway,
      createHandler: (options: DiscoveryJobHandlerOptions) => {
        void options;
        return handler;
      },
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds);
      }
    },
    handler,
    migrations,
    cleanup,
    pendingDispatches,
    recoveredDispatches,
    enqueued,
    queue,
    get connectionAttempts() {
      return connectionAttempts;
    },
    get ended() {
      return ended;
    },
    get workHandler() {
      return workHandler;
    },
    get maintenanceHandler() {
      return maintenanceHandler;
    },
    sleeps
  };
}

describe("worker runtime", () => {
  it("retries database startup before becoming ready and registering work", async () => {
    // Break caught: an independently-started worker could exit before PostgreSQL is ready.
    const fakes = runtimeFakes();

    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    expect(fakes.connectionAttempts).toBe(3);
    expect(fakes.sleeps).toEqual([10, 20]);
    expect(fakes.migrations).toHaveBeenCalledOnce();
    expect(fakes.workHandler).toBeTypeOf("function");
    await expect(runtime.health()).resolves.toEqual({
      live: true,
      ready: true
    });
  });

  it("gives the discovery handler the redacting worker logger", async () => {
    // Break caught: discovery could run with no operational logging at all.
    const fakes = runtimeFakes();
    const logger = { info() {} };
    let handlerOptions: DiscoveryJobHandlerOptions | undefined;
    fakes.dependencies.createHandler = (
      options: DiscoveryJobHandlerOptions
    ) => {
      handlerOptions = options;
      return fakes.handler;
    };

    const runtime = await createWorkerRuntime(
      config,
      fakes.dependencies,
      logger
    );

    expect(handlerOptions?.logger).toBe(logger);
    await runtime.stop();
  });

  it("routes only run ids to the handler", async () => {
    // Break caught: private character lookup values could be forwarded into logs or handlers.
    const fakes = runtimeFakes();
    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    const context = {
      attempt: 3,
      maxAttempts: 5,
      signal: new AbortController().signal
    };
    await fakes.workHandler?.(
      {
        runId: "00000000-0000-4000-8000-000000000003",
        key: { region: "eu", realm: "silvermoon", name: "private-value" }
      },
      context
    );

    expect(fakes.handler.execute).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000003",
      context
    );
    await runtime.stop();
  });

  it("registers maintenance cleanup through the durable queue", async () => {
    // Break caught: expired abuse and suppression policy rows could accumulate forever.
    const fakes = runtimeFakes();
    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    expect(fakes.maintenanceHandler).toBeTypeOf("function");
    await fakes.maintenanceHandler?.();
    expect(fakes.cleanup.rateLimits).toHaveBeenCalledOnce();
    expect(fakes.cleanup.negativeCache).toHaveBeenCalledOnce();
    expect(fakes.cleanup.suppressions).toHaveBeenCalledOnce();
    await runtime.stop();
  });

  it("recovers reservations left pending before registering workers", async () => {
    // Break caught: a web-process crash before enqueue could strand a charged queued run.
    const fakes = runtimeFakes();
    fakes.pendingDispatches.push({
      runId: "00000000-0000-4000-8000-000000000011",
      key: { region: "eu", realm: "silvermoon", name: "pending" }
    });

    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    expect(fakes.enqueued).toEqual(fakes.pendingDispatches);
    expect(fakes.recoveredDispatches).toEqual([
      "00000000-0000-4000-8000-000000000011"
    ]);
    await runtime.stop();
  });

  it("drops readiness before gracefully draining and closing PostgreSQL", async () => {
    // Break caught: shutdown could close storage under an in-flight job.
    const fakes = runtimeFakes();
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const stop = vi.fn(async () => {
      await drain;
    });
    fakes.queue.stop = stop;
    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    const stopping = runtime.stop();
    await expect(runtime.health()).resolves.toEqual({
      live: true,
      ready: false
    });
    expect(stop).toHaveBeenCalledWith({
      graceful: true,
      timeoutMs: 12_345
    });
    expect(fakes.ended).toBe(false);
    releaseDrain();
    await stopping;
    expect(fakes.ended).toBe(true);
  });

  it("propagates a queue settlement timeout without awaiting a blocked pool close", async () => {
    // Break caught: runtime could reintroduce an unbounded wait after queue timeout.
    const fakes = runtimeFakes();
    const stopError = new DiscoveryQueueStopTimeoutError();
    fakes.queue.stop = async () => {
      throw stopError;
    };
    let releasePool!: () => void;
    const blockedPool = new Promise<void>((resolve) => {
      releasePool = resolve;
    });
    fakes.dependencies.createPool = () => ({
      async query() {
        return { rows: [{ "?column?": 1 }] };
      },
      async end() {
        await blockedPool;
      }
    });
    const runtime = await createWorkerRuntime(config, fakes.dependencies);
    const stopping = runtime.stop();

    try {
      const result = await Promise.race([
        stopping.then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error })
        ),
        new Promise<{ kind: "pending" }>((resolve) =>
          setTimeout(() => resolve({ kind: "pending" }), 50)
        )
      ]);
      expect(result).toEqual({ kind: "rejected", error: stopError });
    } finally {
      releasePool();
      await stopping.catch(() => undefined);
    }
  });

  it("fails after the bounded startup attempt count", async () => {
    // Break caught: startup could retry forever and stay deceptively live.
    const fakes = runtimeFakes();
    fakes.dependencies.createPool = () => ({
      async query() {
        throw new Error("database_starting");
      },
      async end() {}
    });

    await expect(
      createWorkerRuntime(config, fakes.dependencies)
    ).rejects.toThrow("database_starting");
    expect(fakes.sleeps).toEqual([10, 20]);
  });

  it("closes queue and database resources when initialization fails", async () => {
    // Break caught: a failed work registration could leak pg-boss and PostgreSQL pools.
    const fakes = runtimeFakes();
    const stop = vi.fn(async () => {});
    fakes.queue.stop = stop;
    fakes.queue.work = async () => {
      throw new Error("work_registration_failed");
    };

    await expect(
      createWorkerRuntime(config, fakes.dependencies)
    ).rejects.toThrow("work_registration_failed");

    expect(stop).toHaveBeenCalledWith({
      graceful: false,
      timeoutMs: 12_345
    });
    expect(fakes.ended).toBe(true);
  });
});
