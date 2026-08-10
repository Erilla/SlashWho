import {
  cleanupExpired,
  createDiscoveryJobHandler,
  recoverPendingSearches,
  type DiscoveryJobHandler,
  type DiscoveryJobHandlerOptions,
  type DiscoveryLogger
} from "@slashwho/application";
import { createBlizzardClient } from "@slashwho/blizzard";
import {
  createDiscoveryQueue,
  createPostgresRepositories,
  DiscoveryQueueStopTimeoutError,
  runMigrations,
  type DiscoveryQueue,
  type Repositories
} from "@slashwho/database";
import type { RaiderIoGateway } from "@slashwho/domain";
import { createRaiderIoClient } from "@slashwho/raiderio";
import { Pool } from "pg";

import type { WorkerConfig } from "./config";
import type { WorkerHealth } from "./health-server";

type RuntimePool = {
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
};

export type WorkerRuntimeDependencies = {
  createPool: (connectionString: string) => RuntimePool;
  runMigrations: (pool: RuntimePool) => Promise<void>;
  createRepositories: (pool: RuntimePool) => Repositories;
  createQueue: (connectionString: string) => DiscoveryQueue;
  createGateway: (config: WorkerConfig) => RaiderIoGateway;
  createFingerprintIntegration?: (
    config: WorkerConfig
  ) => Pick<DiscoveryJobHandlerOptions, "blizzardGateway" | "fingerprint">;
  createHandler: (options: DiscoveryJobHandlerOptions) => DiscoveryJobHandler;
  sleep: (milliseconds: number) => Promise<void>;
};

export type WorkerRuntime = {
  health(): Promise<WorkerHealth>;
  stop(): Promise<void>;
};

export function createFingerprintIntegration(
  config: WorkerConfig
): Pick<DiscoveryJobHandlerOptions, "blizzardGateway" | "fingerprint"> {
  return {
    blizzardGateway: createBlizzardClient({
      fetch: globalThis.fetch,
      clientId: config.blizzardClientId,
      clientSecret: config.blizzardClientSecret,
      baseUrl: config.blizzardBaseUrl
    }),
    fingerprint: {
      requestCap: config.blizzardSweepRequestCap,
      hourlyBudget: config.blizzardHourlyRequestBudget,
      cadenceMs: config.fingerprintSweepCadenceHours * 60 * 60 * 1_000,
      minimumCommon: config.fingerprintMinimumCommon,
      minimumIdenticalPercent: config.fingerprintMinimumIdenticalPercent
    }
  };
}

const defaultDependencies: WorkerRuntimeDependencies = {
  createPool: (connectionString) => new Pool({ connectionString }),
  runMigrations: (pool) => runMigrations(pool as Pool),
  createRepositories: (pool) => createPostgresRepositories(pool as Pool),
  createQueue: (connectionString) => createDiscoveryQueue({ connectionString }),
  createGateway: (config) =>
    createRaiderIoClient({
      fetch: globalThis.fetch,
      baseUrl: config.raiderIoBaseUrl,
      timeoutMs: config.raiderIoTimeoutMs
    }),
  createFingerprintIntegration,
  createHandler: createDiscoveryJobHandler,
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds))
};

function fingerprintAdmissionRetry(retryAt: Date): Error & {
  retryable: true;
  retryAfterMs: number;
} {
  return Object.assign(new Error("fingerprint_admission_waiting"), {
    retryable: true as const,
    retryAfterMs: Math.max(1_000, retryAt.getTime() - Date.now())
  });
}

export async function createWorkerRuntime(
  config: WorkerConfig,
  dependencies: WorkerRuntimeDependencies = defaultDependencies,
  logger?: DiscoveryLogger
): Promise<WorkerRuntime> {
  const pool = dependencies.createPool(config.databaseUrl);
  let queue: DiscoveryQueue | undefined;
  let ready = false;
  let stopping: Promise<void> | undefined;

  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await pool.query("SELECT 1");
        break;
      } catch (error) {
        if (attempt >= config.databaseStartupAttempts) throw error;
        await dependencies.sleep(
          config.databaseStartupRetryMs * 2 ** (attempt - 1)
        );
      }
    }

    await dependencies.runMigrations(pool);
    const repositories = dependencies.createRepositories(pool);
    const initializedQueue = dependencies.createQueue(config.databaseUrl);
    queue = initializedQueue;
    const gateway = dependencies.createGateway(config);
    const fingerprintIntegration =
      dependencies.createFingerprintIntegration?.(config);
    const handler = dependencies.createHandler({
      repositories,
      gateway,
      ...fingerprintIntegration,
      enqueueFingerprintAdmission: (runId) =>
        initializedQueue.enqueueFingerprintAdmission(runId),
      requestCap: config.discoveryRequestCap,
      negativeCacheTtlMs: config.negativeCacheTtlMs,
      ...(logger ? { logger } : {})
    });
    await initializedQueue.start();
    await recoverPendingSearches(repositories, initializedQueue);
    const dispatchAdmittedFingerprintRun = async (runId: string) => {
      const run = await repositories.runs.find(runId);
      if (!run) return;
      await initializedQueue.enqueue({ runId, key: run.rootKey });
      await repositories.fingerprintSweeps.markDispatched(runId, new Date());
    };
    for (let offset = 0; ;) {
      const waitingFingerprintRuns =
        await repositories.fingerprintSweeps.listWaiting(100, offset);
      for (const runId of waitingFingerprintRuns) {
        await initializedQueue.enqueueFingerprintAdmission(runId);
      }
      if (waitingFingerprintRuns.length < 100) break;
      offset += waitingFingerprintRuns.length;
    }
    for (;;) {
      const admittedFingerprintRuns =
        await repositories.fingerprintSweeps.listAdmittedUndispatched(100);
      if (admittedFingerprintRuns.length === 0) break;
      for (const runId of admittedFingerprintRuns) {
        await dispatchAdmittedFingerprintRun(runId);
      }
    }
    await initializedQueue.workFingerprintAdmissions(async (runId) => {
      const admission = await repositories.fingerprintSweeps.admitWaiting(
        runId,
        new Date()
      );
      if (admission.kind === "waiting") {
        const queueWaitMs = Math.max(0, admission.retryAt.getTime() - Date.now());
        if (queueWaitMs >= 15 * 60_000) {
          logger?.info({ event: "fingerprint_admission_blocked", queueWaitMs });
        }
        throw fingerprintAdmissionRetry(admission.retryAt);
      }
      if (admission.kind !== "admitted") return;
      await dispatchAdmittedFingerprintRun(runId);
    });
    await initializedQueue.scheduleMaintenanceCleanup(async () => {
      await cleanupExpired(repositories);
      await recoverPendingSearches(repositories, initializedQueue);
    });
    await initializedQueue.work(async (payload, context) => {
      await handler.execute(payload.runId, context);
    });
    ready = true;

    return {
      async health() {
        if (!ready || !initializedQueue.isReady()) {
          return { live: true, ready: false };
        }
        try {
          await pool.query("SELECT 1");
          return { live: true, ready: true };
        } catch {
          return { live: true, ready: false };
        }
      },

      stop() {
        ready = false;
        stopping ??= (async () => {
          try {
            await initializedQueue.stop({
              graceful: true,
              timeoutMs: config.workerDrainTimeoutMs
            });
          } catch (error) {
            if (error instanceof DiscoveryQueueStopTimeoutError) {
              void pool.end().catch(() => undefined);
              throw error;
            }
            await pool.end();
            throw error;
          }
          await pool.end();
        })();
        return stopping;
      }
    };
  } catch (error) {
    await Promise.allSettled([
      ...(queue
        ? [
            queue.stop({
              graceful: false,
              timeoutMs: config.workerDrainTimeoutMs
            })
          ]
        : []),
      pool.end()
    ]);
    throw error;
  }
}
