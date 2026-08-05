import {
  createSearchService,
  type ApplicationConfig,
  type SearchService
} from "@slashwho/application";
import {
  createDiscoveryQueue,
  createPostgresRepositories,
  runMigrations,
  type DiscoveryQueue,
  type Repositories
} from "@slashwho/database";
import { Pool } from "pg";

import { loadWebConfig, type WebConfig } from "./config";

type WebPool = {
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
};

export type WebContainer = Readonly<{
  searches: SearchService;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}>;

export type WebContainerDependencies = Readonly<{
  createPool(connectionString: string): WebPool;
  runMigrations(pool: WebPool): Promise<void>;
  createRepositories(pool: WebPool): Repositories;
  createQueue(connectionString: string): DiscoveryQueue;
  createSearchService(options: {
    repositories: Repositories;
    queue: Pick<DiscoveryQueue, "enqueue">;
    config: ApplicationConfig;
  }): SearchService;
}>;

const defaultDependencies: WebContainerDependencies = {
  createPool: (connectionString) => new Pool({ connectionString }),
  runMigrations: (pool) => runMigrations(pool as Pool),
  createRepositories: (pool) => createPostgresRepositories(pool as Pool),
  createQueue: (connectionString) => createDiscoveryQueue({ connectionString }),
  createSearchService
};

export async function createWebContainer(
  config: WebConfig,
  dependencies: WebContainerDependencies = defaultDependencies
): Promise<WebContainer> {
  const pool = dependencies.createPool(config.databaseUrl);
  let queue: DiscoveryQueue | undefined;
  try {
    await dependencies.runMigrations(pool);
    const repositories = dependencies.createRepositories(pool);
    const initializedQueue = dependencies.createQueue(config.databaseUrl);
    queue = initializedQueue;
    await initializedQueue.start();
    const searches = dependencies.createSearchService({
      repositories,
      queue: initializedQueue,
      config: config.application
    });
    return {
      searches,
      async ready() {
        try {
          await pool.query("SELECT 1");
          return true;
        } catch {
          return false;
        }
      },
      async close() {
        await Promise.allSettled([
          initializedQueue.stop({ graceful: true, timeoutMs: 5_000 }),
          pool.end()
        ]);
      }
    };
  } catch (error) {
    await Promise.allSettled([
      ...(queue ? [queue.stop({ graceful: false, timeoutMs: 5_000 })] : []),
      pool.end()
    ]);
    throw error;
  }
}

let containerPromise: Promise<WebContainer> | undefined;

export function getContainer(): Promise<WebContainer> {
  containerPromise ??= createWebContainer(loadWebConfig());
  return containerPromise;
}
