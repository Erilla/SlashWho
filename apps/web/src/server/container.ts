import {
  createApplicantDossierService,
  createSearchService,
  upstreamThrottleRecord,
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
import {
  createWarcraftLogsClient,
  type WarcraftLogsGateway
} from "@slashwho/warcraftlogs";
import { Pool } from "pg";
import { createAccountTokens } from "./account-tokens";
import { createAccountCredentials } from "./account-credentials";

import { loadWebConfig, type WebConfig } from "./config";
import {
  createCollectionMonitorService,
  type CollectionMonitorService
} from "./collection-monitor";
import { webLogger } from "./logger";
import {
  createCharacterIdResolver,
  type CharacterIdResolver
} from "./warcraft-logs-characters";
import { createAccountAuth, type AccountAuth } from "./operator-auth";

type WebPool = {
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
};

export type WebContainer = Readonly<{
  searches: SearchService;
  dossiers: ApplicantDossierService;
  collectionMonitor: CollectionMonitorService;
  accountAuth: AccountAuth;
  accountAdmin: Pick<
    Repositories["accountAuth"],
    "listAccounts" | "setRole" | "setActive" | "requirePasswordChange"
  >;
  accountTokens: ReturnType<typeof createAccountTokens> | null;
  accountCredentials?: ReturnType<typeof createAccountCredentials> | null;
  accountRegistration: Pick<
    Repositories["accountAuth"],
    "registerPending" | "admitRegistration"
  >;
  registrationHashSecret: string;
  accountOrigin: string;
  characterIds: CharacterIdResolver;
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
    raiderio: Pick<RaiderIoGateway, "getCharacter">;
    config: ApplicationConfig;
  }): SearchService;
  createRaiderIoGateway(options: {
    fetch: typeof globalThis.fetch;
    baseUrl: string;
    timeoutMs: number;
    accessKey?: string;
    onThrottle?(event: { retryAfterMs: number | undefined }): void;
  }): RaiderIoGateway;
  createBlizzardGateway(options: {
    fetch: typeof globalThis.fetch;
    clientId: string;
    clientSecret: string;
    onThrottle?(event: { retryAfterMs: number | undefined }): void;
  }): BlizzardGateway;
  /** Defaults to the real client; only character-ID resolution uses it. */
  createWarcraftLogsGateway?(options: {
    fetch: typeof globalThis.fetch;
    clientId: string;
    clientSecret: string;
    baseUrl?: string;
    onThrottle?(event: { retryAfterMs: number | undefined }): void;
  }): Pick<WarcraftLogsGateway, "resolveCharacterById">;
  createApplicantDossierService(options: {
    repositories: Pick<
      Repositories,
      "snapshots" | "evidence" | "manualConnections"
    >;
    queue: Pick<DiscoveryQueue, "enqueueCharacterEvidence">;
    search: Pick<SearchService, "create" | "scheduleConnectedCharacterSweep">;
    blizzard: Pick<BlizzardGateway, "getCompletedAchievements">;
    raiderio: Pick<RaiderIoGateway, "getCharacter">;
    config: ApplicationConfig;
    evidenceJobCredentialEncryptionKey: Buffer;
    onCacheEvent?: (source: string, event: string) => void;
    logger?: { info(value: Record<string, unknown>): void };
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
    const accountAuth = createAccountAuth({
      repository: repositories.accountAuth,
      config: config.application,
      ...config.operatorAuth
    });
    const accountTokens = config.accountMail
      ? createAccountTokens({
          repositories,
          tokenHashSecret: config.application.RATE_LIMIT_HASH_SECRET,
          encryptionKey: config.accountMail.encryptionKey,
          origin: config.operatorAuth.origin,
          from: config.accountMail.from
        })
      : null;
    const accountCredentials =
      config.accountCredentialEncryptionKey && repositories.accountCredentials
        ? createAccountCredentials(
            repositories.accountCredentials,
            config.accountCredentialEncryptionKey
          )
        : null;
    const collectionMonitor = createCollectionMonitorService({
      evidence: repositories.evidence
    });
    const initializedQueue = dependencies.createQueue(config.databaseUrl);
    queue = initializedQueue;
    await initializedQueue.start();
    const raiderio = dependencies.createRaiderIoGateway({
      fetch: globalThis.fetch,
      baseUrl: config.dossier.raiderIoBaseUrl,
      timeoutMs: config.dossier.raiderIoTimeoutMs,
      accessKey: config.dossier.raiderIoAccessKey,
      onThrottle: (event) =>
        webLogger.info(upstreamThrottleRecord("raiderio", event))
    });
    const searches = dependencies.createSearchService({
      repositories,
      queue: initializedQueue,
      raiderio,
      config: config.application
    });
    const dossiers = dependencies.createApplicantDossierService({
      repositories,
      search: searches,
      queue: initializedQueue,
      blizzard: dependencies.createBlizzardGateway({
        fetch: globalThis.fetch,
        clientId: config.dossier.blizzardClientId,
        clientSecret: config.dossier.blizzardClientSecret,
        onThrottle: (event) =>
          webLogger.info(upstreamThrottleRecord("blizzard", event))
      }),
      raiderio,
      config: config.application,
      evidenceJobCredentialEncryptionKey:
        config.dossier.evidenceJobCredentialEncryptionKey,
      logger: webLogger
    });
    const createWarcraftLogsGateway =
      dependencies.createWarcraftLogsGateway ?? createWarcraftLogsClient;
    const characterIds = createCharacterIdResolver({
      credentials: config.dossier.warcraftLogs,
      createGateway: (credentials) =>
        createWarcraftLogsGateway({
          fetch: globalThis.fetch,
          ...credentials,
          onThrottle: (event) =>
            webLogger.info(upstreamThrottleRecord("warcraftlogs", event))
        })
    });
    return {
      searches,
      dossiers,
      collectionMonitor,
      accountAuth,
      accountAdmin: repositories.accountAuth,
      accountTokens,
      accountCredentials,
      accountRegistration: repositories.accountAuth,
      registrationHashSecret: config.application.RATE_LIMIT_HASH_SECRET,
      accountOrigin: config.operatorAuth.origin,
      characterIds,
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
