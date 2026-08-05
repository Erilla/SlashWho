import {
  createDiscoveryJobHandler,
  type DiscoveryJobHandler,
  type DiscoveryJobHandlerOptions
} from "@slashwho/application";
import {
  createDiscoveryQueue,
  createPostgresRepositories,
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
  createHandler: (options: DiscoveryJobHandlerOptions) => DiscoveryJobHandler;
  sleep: (milliseconds: number) => Promise<void>;
};

export type WorkerRuntime = {
  health(): Promise<WorkerHealth>;
  stop(): Promise<void>;
};

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
  createHandler: createDiscoveryJobHandler,
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds))
};

export async function createWorkerRuntime(
  config: WorkerConfig,
  dependencies: WorkerRuntimeDependencies = defaultDependencies
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
    const handler = dependencies.createHandler({
      repositories,
      gateway,
      requestCap: config.discoveryRequestCap,
      negativeCacheTtlMs: config.negativeCacheTtlMs
    });
    await initializedQueue.start();
    await initializedQueue.work(async (payload) => {
      await handler.execute(payload.runId);
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
          } finally {
            await pool.end();
          }
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
