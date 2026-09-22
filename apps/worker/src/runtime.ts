import {
  createApplicantEvidenceJobHandler,
  cleanupExpired,
  createDiscoveryJobHandler,
  recoverPendingSearches,
  recoverAbandonedEvidenceRuns,
  resumeWaitingEvidence,
  fullEvidencePhasePlan,
  type DiscoveryJobHandler,
  type DiscoveryJobHandlerOptions,
  type DiscoveryLogger,
  type DiscoveryRunNotifier,
  type EvidenceRunNotifier,
  type FingerprintAlertNotifier
} from "@slashwho/application";
import { createBlizzardClient } from "@slashwho/blizzard";
import {
  collectCharacterEvidenceQueueName,
  createDiscoveryQueue,
  createPostgresRepositories,
  DiscoveryQueueStopTimeoutError,
  discoverCharacterQueueName,
  fingerprintAdmissionQueueName,
  runMigrations,
  type DiscoveryQueue,
  type Repositories
} from "@slashwho/database";
import type { RaiderIoGateway as DiscoveryRaiderIoGateway } from "@slashwho/domain";
import {
  createRaiderIoClient,
  type RaiderIoGateway as EvidenceRaiderIoGateway
} from "@slashwho/raiderio";
import {
  createWarcraftLogsClient,
  type WarcraftLogsGateway
} from "@slashwho/warcraftlogs";
import { Pool } from "pg";

import type { WorkerConfig } from "./config";
import type { WorkerHealth, WorkerHealthProbe } from "./health-server";

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
/**
 * The far backstop: a run older than this is released whatever the queue says
 * about it, so it has to clear the longest life a *healthy* run can have. The
 * evidence queue allows five attempts, each able to occupy its full
 * 1800-second expiry and to wait up to another 1800 seconds before the next,
 * and `started_at` is stamped on the first claim and never advanced -- so a
 * run working normally through a points-budget deferral chain can measure
 * close to five hours old. Eight hours leaves three hours of margin.
 *
 * Almost nothing reaches this. A run that was enqueued is judged by whether
 * its job can still run, and one that was never touched by the orphan cutoff
 * below.
 */
const ABANDONED_EVIDENCE_RUN_RETENTION_MS = 8 * 60 * 60_000;
/**
 * How long a run's recorded points spend is kept (#342). Four weeks, and
 * deliberately weeks rather than years: the question this table answers is
 * always "what does a run cost *now*", and a row older than this describes a
 * configuration that no longer runs. Keeping those would re-open the trap the
 * table was built to close -- a budget re-derived from measurements of a
 * deployment nobody is running any more.
 */
const EVIDENCE_RUN_COST_RETENTION_MS = 28 * 24 * 60 * 60_000;
/**
 * How long a run nothing has ever touched -- no job id, never claimed -- may
 * stay active before recovery releases it. `reserve` inserts the row and
 * `markEnqueued` follows within milliseconds, so a run still in that gap after
 * fifteen minutes is orphaned with near-certainty: its reserving process died
 * before `enqueue` returned.
 *
 * Such a run cannot be deferred and cannot be mid-collection, so the long
 * backstop above buys nothing here and costs a character most of a working
 * day. The margin is against clock skew and a pathologically slow enqueue, not
 * against a deferral chain.
 */
const ORPHANED_EVIDENCE_RESERVATION_MS = 15 * 60_000;
/**
 * How many active runs one tick inspects. Deliberately not
 * `evidenceResumeSweepLimit`: that bounds reserve-and-enqueue work, while this
 * bounds two cheap reads, and sharing it would let a backlog of legitimately
 * queued characters hide an abandoned run behind them indefinitely.
 */
const ABANDONED_EVIDENCE_SCAN_LIMIT = 200;

type RuntimePool = {
  query(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
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
  ) => DiscoveryRaiderIoGateway &
    Pick<EvidenceRaiderIoGateway, "getMythicBossRankings">;
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
  createEvidenceRunNotifier?: (
    config: WorkerConfig,
    logger?: DiscoveryLogger
  ) => EvidenceRunNotifier;
  createHandler: (options: DiscoveryJobHandlerOptions) => DiscoveryJobHandler;
  createEvidenceHandler: typeof createApplicantEvidenceJobHandler;
  sleep: (milliseconds: number) => Promise<void>;
};

export type WorkerRuntime = {
  health(): Promise<WorkerHealth>;
  probe(): Promise<WorkerHealthProbe>;
  stop(): Promise<void>;
};

const workerQueueNames = [
  discoverCharacterQueueName,
  fingerprintAdmissionQueueName,
  collectCharacterEvidenceQueueName
];

async function readWorkerHealthProbe(
  pool: RuntimePool
): Promise<Omit<WorkerHealthProbe, "ready">> {
  const result = await pool.query(
    `SELECT
       CASE
         WHEN MAX(completed_at) IS NULL THEN NULL
         ELSE GREATEST(
           0,
           EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MAX(completed_at))) * 1000
         )
       END AS last_successful_run_age_ms,
       (
         SELECT COUNT(*)
         FROM pgboss.job
         WHERE name = ANY($1::text[])
           AND state < 'active'
       ) AS queue_depth
     FROM discovery_runs
     WHERE status = 'complete'`,
    [workerQueueNames]
  );
  const row = result.rows[0];
  const ageValue = row?.last_successful_run_age_ms;
  const depthValue = row?.queue_depth;
  const lastSuccessfulRunAgeMs =
    ageValue === null || ageValue === undefined ? null : Number(ageValue);
  const queueDepth = Number(depthValue);
  if (
    (lastSuccessfulRunAgeMs !== null &&
      (!Number.isFinite(lastSuccessfulRunAgeMs) ||
        lastSuccessfulRunAgeMs < 0)) ||
    !Number.isInteger(queueDepth) ||
    queueDepth < 0
  ) {
    throw new Error("worker_health_probe_invalid");
  }
  return { lastSuccessfulRunAgeMs, queueDepth };
}

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

/**
 * Announces each evidence run to the same chat webhook as discovery, at its
 * start and again on its outcome. Evidence runs spend the Warcraft Logs
 * allowance, so `limitationCode`, `parseLimitationCode` and the points spent
 * are what the message exists to carry.
 *
 * Delivery is best effort throughout, exactly as it is for a discovery run:
 * the channel is a convenience for whoever is watching, never a dependency of
 * the run.
 */
export function createEvidenceRunNotifier(
  config: WorkerConfig,
  options: {
    logger?: DiscoveryLogger;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
  } = {}
): EvidenceRunNotifier {
  const fetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;

  async function post(content: string): Promise<void> {
    if (!config.discoveryWebhookUrl) return;
    try {
      const response = await fetch(config.discoveryWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) {
        options.logger?.info({
          event: "evidence_announcement_delivery_failed",
          failure: "http_status",
          status: response.status
        });
      }
    } catch {
      options.logger?.info({
        event: "evidence_announcement_delivery_failed",
        failure: "network_or_timeout"
      });
    }
  }

  return {
    async started(run) {
      await post(
        `🧾 Evidence run started — **${run.name}** (${run.region}/${run.realm}) · attempt ${run.attempt} · run \`${run.runId}\``
      );
    },
    async finished(run) {
      // Only what is actually known: a run with no limitation and no readable
      // allowance announces its outcome and nothing more.
      const limitations = [run.limitationCode, run.parseLimitationCode].filter(
        (code): code is string => Boolean(code)
      );
      const details = [
        ...(limitations.length > 0 ? [limitations.join(" / ")] : []),
        ...(run.pointsSpent === null ? [] : [`${run.pointsSpent} points`])
      ];
      const icon = run.outcome === "complete" ? "✅" : "⚠️";
      await post(
        [
          `${icon} Evidence run ${run.outcome} — **${run.name}** (${run.region}/${run.realm})`,
          ...details,
          `run \`${run.runId}\``
        ].join(" · ")
      );
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
 * The worker's own Raider.IO client. It receives the server-configured access
 * key when one is set, but the shared client attaches it only to official
 * /api/v1 requests. There is no visitor on this path to supply a key of their
 * own.
 */
export function createRaiderIoGateway(
  config: WorkerConfig,
  logger?: DiscoveryLogger
): DiscoveryRaiderIoGateway &
  Pick<EvidenceRaiderIoGateway, "getMythicBossRankings"> {
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
  createEvidenceRunNotifier: (config, logger) =>
    createEvidenceRunNotifier(config, { logger }),
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
      enqueueFullEvidence: async (key) => {
        const at = new Date();
        // A fingerprint admission is a genuinely new dossier connection, so
        // use `at` as the cutoff and collect its complete public log history.
        // `reserve` coalesces an already active collection instead of queuing
        // duplicate work.
        const reservation = await repositories.evidence.reserve({
          key,
          freshnessCutoff: at,
          at,
          phasePlan: fullEvidencePhasePlan()
        });
        if (reservation.kind !== "reserved") return;
        const queueJobId = await initializedQueue.enqueueCharacterEvidence(
          reservation.run.id,
          { enqueuedAt: at.toISOString(), mode: "full" }
        );
        await repositories.evidence.markEnqueued(
          reservation.run.id,
          queueJobId
        );
      },
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
    const evidenceRunNotifier = dependencies.createEvidenceRunNotifier?.(
      config,
      logger
    );
    const evidenceHandler = dependencies.createEvidenceHandler({
      evidence,
      warcraftLogs: dependencies.createEvidenceGateway(config, logger),
      // These are collection dependencies too: the dossier reader only reads
      // the facts this worker publishes, so progress and publication share
      // one durable run.
      raiderio: gateway,
      ...(fingerprintIntegration?.blizzardGateway
        ? { blizzard: fingerprintIntegration.blizzardGateway }
        : {}),
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
      capRetryMs: config.evidenceCapRetryMs,
      transientRetryMs: config.evidenceTransientRetryMs,
      pointsReserve: config.evidencePointsReserve,
      killSettleMs: config.evidenceKillSettleDays * 24 * 60 * 60 * 1000,
      retryCostCeiling: config.evidenceRetryCostCeiling,
      failureCooldownMs: config.evidenceFailureCooldownMs,
      ...(evidenceRunNotifier ? { evidenceRunNotifier } : {}),
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
    // What actually drives a waiting run. `reserve` is otherwise reached only
    // from a dossier read or the refresh endpoint, so a run that deferred
    // itself resumed only when somebody happened to load the page — which made
    // the dossier nobody was watching the one that quietly never finished.
    //
    // It only reserves and enqueues. The evidence queue still collects one run
    // at a time and the points gate still refuses a run it cannot afford, so
    // this cannot spend more per hour than a reader already could.
    await initializedQueue.scheduleEvidenceResume(async () => {
      // Recovery runs first, and shares this five-minute schedule rather than
      // the hourly cleanup, because an abandoned run is precisely what hides a
      // character from the pass below: `reserve` counts it as active, so the
      // resume sweep skips that character as already in hand. Releasing first
      // means one whose previous evidence is due can resume on this same tick
      // instead of waiting for the next one.
      //
      // Guarded, and not merely for tidiness: an unguarded throw here would
      // skip the resume pass below on every tick, and the resume queue's
      // `retryLimit` is 1, so the only symptom would be a log line that
      // stopped appearing while no character was ever resumed again.
      let released = 0;
      let republished = 0;
      try {
        ({ released, republished } = await recoverAbandonedEvidenceRuns(
          repositories.evidence,
          initializedQueue,
          {
            startedBefore: new Date(
              Date.now() - ABANDONED_EVIDENCE_RUN_RETENTION_MS
            ),
            reservedBefore: new Date(
              Date.now() - ORPHANED_EVIDENCE_RESERVATION_MS
            ),
            settleMs: config.evidenceKillSettleDays * 24 * 60 * 60 * 1000,
            limit: ABANDONED_EVIDENCE_SCAN_LIMIT
          }
        ));
      } catch (error) {
        logger?.info({
          event: "evidence_recovery_failed",
          failure: error instanceof Error ? error.name : "unknown"
        });
      }
      const resumed = await resumeWaitingEvidence(
        repositories.evidence,
        initializedQueue,
        {
          freshnessCutoff: new Date(
            Date.now() - config.evidenceFreshnessHours * 60 * 60 * 1000
          ),
          limit: config.evidenceResumeSweepLimit,
          ...(logger ? { logger } : {})
        }
      );
      // Counts only, never a character key -- recovery reads one now, to mark
      // the tiers a republished stage earned, and it must not leak here. This
      // says whether the sweep is doing anything, which is the thing that was
      // impossible to tell before it existed.
      logger?.info({
        event: "evidence_resume_sweep",
        resumed,
        released,
        republished
      });
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
      // A stage belongs to an attempt in flight. One whose run has settled is
      // work nothing will ever republish, so it is dropped rather than left to
      // hold a copy of the evidence indefinitely.
      const removedCollectionStages =
        await repositories.evidence.clearSettledCollectionStages();
      // Counts only, like the two above it.
      const removedRunCosts = await repositories.evidence.clearExpiredRunCosts(
        new Date(Date.now() - EVIDENCE_RUN_COST_RETENTION_MS)
      );
      logger?.info({
        event: "evidence_cache_cleanup",
        removedEvidenceRuns,
        removedCollectionStages,
        removedRunCosts
      });
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

      async probe() {
        if (!ready || !initializedQueue.isReady()) {
          return {
            ready: false,
            lastSuccessfulRunAgeMs: null,
            queueDepth: 0
          };
        }
        try {
          return {
            ready: true,
            ...(await readWorkerHealthProbe(pool))
          };
        } catch {
          return {
            ready: false,
            lastSuccessfulRunAgeMs: null,
            queueDepth: 0
          };
        }
      },

      stop() {
        ready = false;
        stopping ??= (async () => {
          try {
            await initializedQueue.stop({
              graceful: true,
              timeoutMs: config.workerDrainTimeoutMs,
              // Waiting out the whole budget was the bug: an evidence run
              // cannot finish inside it, so the wait only ever expired. The
              // grace covers a job that is nearly done; past it the run is
              // aborted, and the handler releases it with the remainder.
              abortGraceMs: config.workerAbortGraceMs
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
