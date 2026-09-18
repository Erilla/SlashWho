import {
  createApplicantEvidenceJobHandler,
  cleanupExpired,
  createDiscoveryJobHandler,
  recoverPendingSearches,
  type DiscoveryJobHandler,
  type DiscoveryJobHandlerOptions,
  type DiscoveryLogger,
  type DiscoveryRunNotifier,
  type FingerprintAlertNotifier
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
import {
  createWarcraftLogsClient,
  type WarcraftLogsGateway
} from "@slashwho/warcraftlogs";
import { Pool } from "pg";

import type { WorkerConfig } from "./config";
import type { WorkerHealth } from "./health-server";

// Ciphertext for an abandoned evidence run's WCL credentials should not
// outlive the run by more than this window. Normal completion (`publish` or
// `fail`) clears these columns immediately; this is only the backstop for a
// job that never reaches either.
const STALE_EVIDENCE_CREDENTIAL_RETENTION_MS = 60 * 60_000;
/**
 * A still-active run keeps its credentials for longer, because it may simply
 * be waiting: a points-budget refusal defers a run for up to five attempts of
 * 1800 seconds, so a live run can legitimately be 2.5 hours old. Stripping it
 * mid-flight does not fail the run -- it falls back to the worker's shared
 * account and spends the wrong allowance on a visitor's dossier.
 */
const STALE_ACTIVE_EVIDENCE_CREDENTIAL_RETENTION_MS = 6 * 60 * 60_000;

type RuntimePool = {
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
};

export type WorkerRuntimeDependencies = {
  createPool: (connectionString: string) => RuntimePool;
  runMigrations: (pool: RuntimePool) => Promise<void>;
  createRepositories: (pool: RuntimePool) => Repositories;
  createQueue: (connectionString: string) => DiscoveryQueue;
  createGateway: (
    config: WorkerConfig,
    logger?: DiscoveryLogger
  ) => RaiderIoGateway;
  createEvidenceGateway: (
    config: WorkerConfig,
    logger?: DiscoveryLogger
  ) => Pick<WarcraftLogsGateway, "getFirstKillReports" | "getRateLimit">;
  createFingerprintIntegration?: (
    config: WorkerConfig,
    logger?: DiscoveryLogger
  ) => Pick<DiscoveryJobHandlerOptions, "blizzardGateway" | "fingerprint">;
  createFingerprintAlertNotifier?: (
    config: WorkerConfig,
    logger?: DiscoveryLogger
  ) => FingerprintAlertNotifier;
  createDiscoveryRunNotifier?: (
    config: WorkerConfig,
    logger?: DiscoveryLogger
  ) => DiscoveryRunNotifier;
  createHandler: (options: DiscoveryJobHandlerOptions) => DiscoveryJobHandler;
  createEvidenceHandler: typeof createApplicantEvidenceJobHandler;
  sleep: (milliseconds: number) => Promise<void>;
};

export type WorkerRuntime = {
  health(): Promise<WorkerHealth>;
  stop(): Promise<void>;
};

export function createFingerprintIntegration(
  config: WorkerConfig,
  logger?: DiscoveryLogger
): Pick<DiscoveryJobHandlerOptions, "blizzardGateway" | "fingerprint"> {
  return {
    blizzardGateway: createBlizzardClient({
      fetch: globalThis.fetch,
      clientId: config.blizzardClientId,
      clientSecret: config.blizzardClientSecret,
      baseUrl: config.blizzardBaseUrl,
      onThrottle: (event) =>
        logger?.info({
          event: "upstream_throttle",
          provider: "blizzard",
          retryAfterMs: event.retryAfterMs ?? null
        })
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

/**
 * Announces each discovery run to a chat webhook. Discord rejects any body
 * without `content`, `embeds` or `file`, so the run is rendered as a message
 * rather than posted as the raw record. Delivery is best effort: the channel is
 * a convenience for whoever is watching, never a dependency of the run.
 */
export function createDiscoveryRunNotifier(
  config: WorkerConfig,
  options: {
    logger?: DiscoveryLogger;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
  } = {}
): DiscoveryRunNotifier {
  const fetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  return {
    async started(run) {
      if (!config.discoveryWebhookUrl) return;
      const content = `🔍 Discovery run started — **${run.name}** (${run.region}/${run.realm}) · attempt ${run.attempt} · run \`${run.runId}\``;
      try {
        const response = await fetch(config.discoveryWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) {
          options.logger?.info({
            event: "discovery_announcement_delivery_failed",
            failure: "http_status",
            status: response.status
          });
        }
      } catch {
        options.logger?.info({
          event: "discovery_announcement_delivery_failed",
          failure: "network_or_timeout"
        });
      }
    }
  };
}

export function createFingerprintAlertNotifier(
  config: WorkerConfig,
  options: {
    fetch?: typeof globalThis.fetch;
    logger?: DiscoveryLogger;
    timeoutMs?: number;
  } = {}
): FingerprintAlertNotifier {
  const fetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  return {
    async notify(alert) {
      if (!config.maintainerAlertWebhookUrl) return;
      try {
        const response = await fetch(config.maintainerAlertWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(alert),
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) {
          options.logger?.info({
            event: "maintainer_alert_delivery_failed",
            alertEvent: alert.event,
            failure: "http_status",
            status: response.status
          });
        }
      } catch {
        options.logger?.info({
          event: "maintainer_alert_delivery_failed",
          alertEvent: alert.event,
          failure: "network_or_timeout"
        });
      }
    }
  };
}

/**
 * The worker's own Raider.IO client. It carries the server-configured access
 * key when one is set, and is anonymous when it is not — there is no visitor
 * on this path to supply a key of their own.
 */
export function createRaiderIoGateway(
  config: WorkerConfig,
  logger?: DiscoveryLogger
): RaiderIoGateway {
  return createRaiderIoClient({
    fetch: globalThis.fetch,
    baseUrl: config.raiderIoBaseUrl,
    timeoutMs: config.raiderIoTimeoutMs,
    accessKey: config.raiderIoAccessKey,
    onThrottle: (event) =>
      logger?.info({
        event: "upstream_throttle",
        provider: "raiderio",
        retryAfterMs: event.retryAfterMs ?? null
      })
  });
}

const defaultDependencies: WorkerRuntimeDependencies = {
  createPool: (connectionString) => new Pool({ connectionString }),
  runMigrations: (pool) => runMigrations(pool as Pool),
  createRepositories: (pool) => createPostgresRepositories(pool as Pool),
  createQueue: (connectionString) => createDiscoveryQueue({ connectionString }),
  createGateway: createRaiderIoGateway,
  createEvidenceGateway: (config, logger) =>
    createWarcraftLogsClient({
      fetch: globalThis.fetch,
      clientId: config.warcraftLogsClientId,
      clientSecret: config.warcraftLogsClientSecret,
      onThrottle: (event) =>
        logger?.info({
          event: "upstream_throttle",
          provider: "warcraftlogs",
          retryAfterMs: event.retryAfterMs ?? null
        })
    }),
  createFingerprintIntegration,
  createFingerprintAlertNotifier: (config, logger) =>
    createFingerprintAlertNotifier(config, { logger }),
  createDiscoveryRunNotifier: (config, logger) =>
    createDiscoveryRunNotifier(config, { logger }),
  createHandler: createDiscoveryJobHandler,
  createEvidenceHandler: createApplicantEvidenceJobHandler,
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
    const gateway = dependencies.createGateway(config, logger);
    const fingerprintIntegration = dependencies.createFingerprintIntegration?.(
      config,
      logger
    );
    const fingerprintAlertNotifier =
      dependencies.createFingerprintAlertNotifier?.(config, logger);
    const discoveryRunNotifier = dependencies.createDiscoveryRunNotifier?.(
      config,
      logger
    );
    const handler = dependencies.createHandler({
      repositories,
      gateway,
      ...fingerprintIntegration,
      ...(fingerprintAlertNotifier ? { fingerprintAlertNotifier } : {}),
      ...(discoveryRunNotifier ? { discoveryRunNotifier } : {}),
      enqueueFingerprintAdmission: (runId) =>
        initializedQueue.enqueueFingerprintAdmission(runId),
      requestCap: config.discoveryRequestCap,
      negativeCacheTtlMs: config.negativeCacheTtlMs,
      ...(logger ? { logger } : {})
    });
    const evidence = (
      repositories as Repositories & {
        evidence: Parameters<
          typeof createApplicantEvidenceJobHandler
        >[0]["evidence"];
      }
    ).evidence;
    if (!evidence) throw new Error("character_evidence_repository_unavailable");
    const evidenceHandler = dependencies.createEvidenceHandler({
      evidence,
      warcraftLogs: dependencies.createEvidenceGateway(config, logger),
      // A run carrying a visitor's own credentials gets its own client, and it
      // reports throttling exactly as the shared one does: the record names the
      // provider and the delay only, never whose key was in use.
      createWarcraftLogsGateway: (credentials) =>
        createWarcraftLogsClient({
          fetch: globalThis.fetch,
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          onThrottle: (event) =>
            logger?.info({
              event: "upstream_throttle",
              provider: "warcraftlogs",
              retryAfterMs: event.retryAfterMs ?? null
            })
        }),
      decryptionKey: config.evidenceJobCredentialEncryptionKey,
      requestCap: config.evidenceRequestCap,
      parseRequestCap: config.evidenceParseRequestCap,
      parseCapRetryMs: config.evidenceParseCapRetryMs,
      pointsReserve: config.evidencePointsReserve,
      ...(logger ? { logger } : {})
    });
    await initializedQueue.start();
    await recoverPendingSearches(repositories, initializedQueue);
    const dispatchAdmittedFingerprintRun = async (runId: string) => {
      const run = await repositories.runs.find(runId);
      if (!run) return;
      const resume = await repositories.fingerprintSweeps.getResumeState(
        run.rootKey
      );
      // The root having a cursor is not enough: the cursor belongs to whichever
      // run published the snapshot it points at. A fresh refresh for the same
      // root is a different run, and dispatching it as a continuation would
      // skip its own discovery entirely and amend someone else's snapshot
      // without ever completing itself. It goes out as an ordinary job.
      const continues = resume !== null && resume.runId === runId;
      // No correlationId is available here: this dispatch is a background
      // fingerprint-admission follow-up, not the continuation of an HTTP
      // request, so it stays absent rather than being invented.
      await initializedQueue.enqueue({
        runId,
        key: run.rootKey,
        enqueuedAt: new Date().toISOString(),
        ...(continues ? { continuation: true as const } : {})
      });
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
        const blockedForMs = admission.blockedSince
          ? Math.max(0, Date.now() - admission.blockedSince.getTime())
          : 0;
        if (blockedForMs >= 15 * 60_000) {
          logger?.info({
            event: "fingerprint_admission_blocked",
            blockedForMs
          });
        }
        throw fingerprintAdmissionRetry(admission.retryAt);
      }
      if (admission.kind !== "admitted") return;
      await dispatchAdmittedFingerprintRun(runId);
    });
    await initializedQueue.scheduleMaintenanceCleanup(async () => {
      await cleanupExpired(repositories);
      const removedEvidenceRuns =
        await repositories.evidence.clearStaleCredentials({
          settled: new Date(
            Date.now() - STALE_EVIDENCE_CREDENTIAL_RETENTION_MS
          ),
          active: new Date(
            Date.now() - STALE_ACTIVE_EVIDENCE_CREDENTIAL_RETENTION_MS
          )
        });
      // On the injected logger rather than console.info: this record now passes
      // through the worker's redaction like every other one. It carries a count
      // only — never a credential, a run id or a character key.
      logger?.info({ event: "evidence_cache_cleanup", removedEvidenceRuns });
      await recoverPendingSearches(repositories, initializedQueue);
    });
    await initializedQueue.work(async (payload, context) => {
      await handler.execute(
        payload.runId,
        {
          ...context,
          correlationId: payload.correlationId,
          enqueuedAt: payload.enqueuedAt
        },
        payload
      );
    });
    await initializedQueue.workCharacterEvidence(async (payload, context) => {
      await evidenceHandler.execute(payload, context);
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
