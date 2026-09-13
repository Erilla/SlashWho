import {
  createApplicantDossierService,
  createSearchService,
  type ApplicantDossierService,
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
import { createRaiderIoClient, type RaiderIoGateway } from "@slashwho/raiderio";
import { createBlizzardClient, type BlizzardGateway } from "@slashwho/blizzard";
import { Pool } from "pg";

import { loadWebConfig, type WebConfig } from "./config";

type WebPool = {
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
};

export type WebContainer = Readonly<{
  searches: SearchService;
  dossiers: ApplicantDossierService;
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
  createRaiderIoGateway(options: {
    fetch: typeof globalThis.fetch;
    baseUrl: string;
    timeoutMs: number;
  }): RaiderIoGateway;
  createBlizzardGateway(options: {
    fetch: typeof globalThis.fetch;
    clientId: string;
    clientSecret: string;
  }): BlizzardGateway;
  createApplicantDossierService(options: {
    repositories: Pick<Repositories, "snapshots" | "evidence">;
    queue: Pick<DiscoveryQueue, "enqueueCharacterEvidence">;
    search: Pick<SearchService, "create">;
    blizzard: Pick<BlizzardGateway, "getCompletedAchievements">;
    raiderio: Pick<RaiderIoGateway, "getMythicBossRankings">;
    config: ApplicationConfig;
  }): ApplicantDossierService;
}>;

const defaultDependencies: WebContainerDependencies = {
  createPool: (connectionString) => new Pool({ connectionString }),
  runMigrations: (pool) => runMigrations(pool as Pool),
  createRepositories: (pool) => createPostgresRepositories(pool as Pool),
  createQueue: (connectionString) => createDiscoveryQueue({ connectionString }),
  createSearchService,
  createRaiderIoGateway: createRaiderIoClient,
  createBlizzardGateway: createBlizzardClient,
  createApplicantDossierService
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
    const dossiers = dependencies.createApplicantDossierService({
      repositories,
      search: searches,
      queue: initializedQueue,
      blizzard: dependencies.createBlizzardGateway({
        fetch: globalThis.fetch,
        clientId: config.dossier.blizzardClientId,
        clientSecret: config.dossier.blizzardClientSecret
      }),
      raiderio: dependencies.createRaiderIoGateway({
        fetch: globalThis.fetch,
        baseUrl: config.dossier.raiderIoBaseUrl,
        timeoutMs: config.dossier.raiderIoTimeoutMs
      }),
      config: config.application
    });
    return {
      searches,
      dossiers,
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

export function createContainerProvider(
  factory: () => Promise<WebContainer>
): () => Promise<WebContainer> {
  let promise: Promise<WebContainer> | undefined;
  return () => {
    promise ??= factory().catch((error: unknown) => {
      promise = undefined;
      throw error;
    });
    return promise;
  };
}

export const getContainer = createContainerProvider(() =>
  createWebContainer(loadWebConfig())
);
