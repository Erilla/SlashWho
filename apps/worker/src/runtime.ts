import { hkdfSync } from "node:crypto";
import {
  createApplicantEvidenceJobHandler,
  cleanupExpired,
  createDiscoveryJobHandler,
  recoverPendingSearches,
  recoverStrandedContinuations,
  recoverAbandonedEvidenceRuns,
  resumeWaitingEvidence,
  fullEvidencePhasePlan,
  attributeThrottlesTo,
  decryptCredential,
  throttleReporter,
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
import {
  characterGroupsErrorCode,
  type RaiderIoGateway as DiscoveryRaiderIoGateway
} from "@slashwho/domain";
import {
  createRaiderIoClient,
  type RaiderIoGateway as EvidenceRaiderIoGateway
} from "@slashwho/raiderio";
import {
  createWarcraftLogsClient,
  type WarcraftLogsGateway
} from "@slashwho/warcraftlogs";
import { Pool } from "pg";

import { createApplicantSheetClient } from "./applicant-sheet";
import { decodeApplicantIdentity } from "./applicant-identity";
import {
  drainApplicantIntents,
  pollApplicantSheet,
  wasSuppressedAt
} from "./applicant-watcher";
import type { WorkerConfig } from "./config";
import { type Clock, elapsedMs, monotonicClock } from "./cycle-log";
import { errorName } from "./process-errors";
import {
  AccountMailStopTimeoutError,
  startAccountMailWorker
} from "./account-mail";
import type { WorkerHealth, WorkerHealthProbe } from "./health-server";
import {
  announceNewApplicantIntents,
  createDiscoveryRunNotifier,
  createEvidenceRunNotifier,
  createFingerprintAlertNotifier
} from "./notifiers";

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
  startAccountMailWorker?: typeof startAccountMailWorker;
  /** Times each background cycle; monotonic by default. */
  clock?: Clock;
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
  ) => Pick<WarcraftLogsGateway, "getFirstKillReports" | "getRateLimit"> &
    Partial<
      Pick<
        WarcraftLogsGateway,
        "resolveCharacter" | "resolveCharacterById" | "getRateLimitWithIdentity"
      >
    >;
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

export type QueueDepth = { depth: number; oldestWaitMs: number | null };

// Counts only, never a payload or singleton key: a job's data carries a
// character key, and this record exists to be kept and read over time.
// "Waiting" matches the probe's depth (anything not yet active), and the age
// runs from enqueue, so a retried job keeps its original age.
export async function readQueueDepths(
  pool: RuntimePool
): Promise<Record<string, QueueDepth>> {
  const result = await pool.query(
    `SELECT
       name,
       COUNT(*) AS depth,
       GREATEST(
         0,
         EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MIN(created_on))) * 1000
       ) AS oldest_wait_ms
     FROM pgboss.job
     WHERE name = ANY($1::text[])
       AND state < 'active'
     GROUP BY name`,
    [workerQueueNames]
  );
  const queues: Record<string, QueueDepth> = Object.fromEntries(
    workerQueueNames.map((name) => [name, { depth: 0, oldestWaitMs: null }])
  );
  for (const row of result.rows) {
    const name = row?.name;
    const depth = Number(row?.depth);
    const oldestWaitMs = Math.round(Number(row?.oldest_wait_ms));
    if (
      typeof name !== "string" ||
      !(name in queues) ||
      !Number.isInteger(depth) ||
      depth < 0 ||
      !Number.isFinite(oldestWaitMs) ||
      oldestWaitMs < 0
    ) {
      throw new Error("worker_queue_depth_invalid");
    }
    queues[name] = { depth, oldestWaitMs };
  }
  return queues;
}

/**
 * Limits on the worker's single Blizzard client, which discovery sweeps and
 * evidence runs share, so they bound the process rather than one caller.
 * Blizzard allows the credentials 100 requests a second and the web service
 * spends the same allowance, so the worker takes two fifths of it; the web's
 * own limiter (BLIZZARD_WEB_REQUEST_LIMITS) takes another fifth, and the
 * runtime test holds the sum to 80. The rate limit, not the concurrency, is
 * what bounds that share: 10 in flight at a pessimistic 100 ms would be 100 a
 * second. The concurrency is sized to reach the limit instead: at 40 a second
 * and 6 in flight, a measured full run managed only 24 a second, because 6
 * reads at the 219 ms mean it saw cannot go faster (#655). 10 in flight reaches
 * about 45 a second at that mean, so the limit binds in normal running and the
 * worker spends its full share rather than only when Blizzard is fast. Both are
 * per process, which is per credential only while the worker runs one
 * replica. See
 * docs/research/2026-09-26-issue-549-blizzard-sweep-concurrency.md.
 */
export const BLIZZARD_WORKER_REQUEST_LIMITS = {
  maxConcurrent: 10,
  maxPerSecond: 40
} as const;

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
      onThrottle: throttleReporter(logger, "blizzard"),
      requestLimits: BLIZZARD_WORKER_REQUEST_LIMITS
    }),
    fingerprint: {
      requestCap: config.blizzardSweepRequestCap,
      // The sweep offers as many reads as the client will run at once; the
      // client, not the sweep, holds the line.
      readConcurrency: BLIZZARD_WORKER_REQUEST_LIMITS.maxConcurrent,
      hourlyBudget: config.blizzardHourlyRequestBudget,
      cadenceMs: config.fingerprintSweepCadenceHours * 60 * 60 * 1_000,
      minimumCommon: config.fingerprintMinimumCommon,
      minimumIdenticalPercent: config.fingerprintMinimumIdenticalPercent
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
    onThrottle: throttleReporter(logger, "raiderio")
  });
}

/**
 * The shared Warcraft Logs client. `baseUrl` moves both the OAuth token and the
 * GraphQL requests; unset, they go to warcraftlogs.com.
 */
export function createEvidenceGateway(
  config: WorkerConfig,
  logger?: DiscoveryLogger
): WarcraftLogsGateway {
  return createWarcraftLogsClient({
    fetch: globalThis.fetch,
    clientId: config.warcraftLogsClientId,
    clientSecret: config.warcraftLogsClientSecret,
    baseUrl: config.warcraftLogsBaseUrl,
    onThrottle: throttleReporter(logger, "warcraftlogs")
  });
}

export function createAccountWarcraftLogsResolver(
  repository:
    | {
        get(
          accountId: string,
          provider: "warcraftlogs"
        ): Promise<{ encryptedPayload: string | null; version: number } | null>;
      }
    | undefined,
  masterKey: Buffer | undefined
) {
  return async (accountId: string, credentialVersion: number) => {
    if (!masterKey) return null;
    // The repository get joins the active, verified account. A disabled owner
    // therefore has no usable record, even while the run remains queued.
    const row = await repository?.get(accountId, "warcraftlogs");
    if (!row?.encryptedPayload || row.version !== credentialVersion)
      return null;
    const key = Buffer.from(
      hkdfSync("sha256", masterKey, "", "account-provider-credentials-v1", 32)
    );
    const values: unknown = JSON.parse(
      decryptCredential(row.encryptedPayload, key)
    );
    if (
      !values ||
      typeof values !== "object" ||
      !("clientId" in values) ||
      !("clientSecret" in values) ||
      typeof values.clientId !== "string" ||
      typeof values.clientSecret !== "string"
    )
      return null;
    return {
      values: { clientId: values.clientId, clientSecret: values.clientSecret },
      version: row.version
    };
  };
}

const defaultDependencies: WorkerRuntimeDependencies = {
  createPool: (connectionString) =>
    new Pool({ connectionString, connectionTimeoutMillis: 10_000 }),
  runMigrations: (pool) => runMigrations(pool as Pool),
  createRepositories: (pool) => createPostgresRepositories(pool as Pool),
  createQueue: (connectionString) => createDiscoveryQueue({ connectionString }),
  createGateway: createRaiderIoGateway,
  createEvidenceGateway,
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
    // Whole seconds: the queue ignores any other delay and falls back to its
    // default, which would miss a deferred continuation's time by up to a
    // minute.
    retryAfterMs:
      Math.ceil(Math.max(1_000, retryAt.getTime() - Date.now()) / 1_000) * 1_000
  });
}

/** What every stage of the runtime shares once storage and the queue are up. */
type WorkerContext = Readonly<{
  config: WorkerConfig;
  pool: RuntimePool;
  repositories: Repositories;
  queue: DiscoveryQueue;
  clock: Clock;
  logger: DiscoveryLogger | undefined;
}>;

/**
 * Waits for the database to answer, backing off exponentially between
 * attempts, and rethrows the last failure once the attempts run out.
 */
async function connectWithRetry(
  pool: RuntimePool,
  config: WorkerConfig,
  sleep: WorkerRuntimeDependencies["sleep"]
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      if (attempt >= config.databaseStartupAttempts) throw error;
      await sleep(config.databaseStartupRetryMs * 2 ** (attempt - 1));
    }
  }
}

type WorkerHandlers = Readonly<{
  handler: DiscoveryJobHandler;
  evidenceHandler: ReturnType<typeof createApplicantEvidenceJobHandler>;
  gateway: ReturnType<WorkerRuntimeDependencies["createGateway"]>;
  evidenceGateway: ReturnType<
    WorkerRuntimeDependencies["createEvidenceGateway"]
  >;
  fingerprintAlertNotifier: FingerprintAlertNotifier | undefined;
}>;

/**
 * The discovery and evidence job handlers, with the upstream clients and
 * notifiers they are built on. Nothing here touches the queue's workers or
 * schedules; it only wires dependencies together.
 */
function buildHandlers(
  context: WorkerContext,
  dependencies: WorkerRuntimeDependencies
): WorkerHandlers {
  const { config, repositories, queue, logger } = context;
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
      queue.enqueueFingerprintAdmission(runId),
    enqueueFullEvidence: async (key, root) => {
      const at = new Date();
      // A fingerprint admission is a genuinely new dossier connection, so
      // use `at` as the cutoff and collect its complete public log history.
      // `reserve` coalesces an already active collection instead of queuing
      // duplicate work.
      const reservation = await repositories.evidence.reserve({
        key,
        origin: "fingerprint_admission",
        root,
        freshnessCutoff: at,
        at,
        phasePlan: fullEvidencePhasePlan()
      });
      if (reservation.kind !== "reserved") return;
      const queueJobId = await queue.enqueueCharacterEvidence(
        reservation.run.id,
        { enqueuedAt: at.toISOString(), mode: "full" }
      );
      await repositories.evidence.markEnqueued(reservation.run.id, queueJobId);
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
  const evidenceGateway = dependencies.createEvidenceGateway(config, logger);
  const evidenceHandler = dependencies.createEvidenceHandler({
    evidence,
    isSuppressed: (key) => repositories.suppressions.isActive(key, new Date()),
    warcraftLogs: evidenceGateway,
    resolveAccountWarcraftLogs: createAccountWarcraftLogsResolver(
      repositories.accountCredentials,
      config.accountCredentialEncryptionKey
    ),
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
        baseUrl: config.warcraftLogsBaseUrl,
        onThrottle: throttleReporter(logger, "warcraftlogs")
      }),
    decryptionKey: config.evidenceJobCredentialEncryptionKey,
    requestCap: config.evidenceRequestCap,
    parseRequestCap: config.evidenceParseRequestCap,
    tierSearchRequestCap: config.evidenceTierSearchRequestCap,
    capRetryMs: config.evidenceCapRetryMs,
    transientRetryMs: config.evidenceTransientRetryMs,
    pointsReserve: config.evidencePointsReserve,
    killSettleMs: config.evidenceKillSettleDays * 24 * 60 * 60 * 1000,
    retryCostCeiling: config.evidenceRetryCostCeiling,
    failureCooldownMs: config.evidenceFailureCooldownMs,
    ...(evidenceRunNotifier ? { evidenceRunNotifier } : {}),
    ...(logger ? { logger } : {})
  });
  return {
    handler,
    evidenceHandler,
    gateway,
    evidenceGateway,
    fingerprintAlertNotifier
  };
}

/** Sends an admitted fingerprint run back to discovery. */
function fingerprintRunDispatcher(
  context: WorkerContext
): (runId: string) => Promise<void> {
  const { repositories, queue } = context;
  return async (runId) => {
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
    await queue.enqueue({
      runId,
      key: run.rootKey,
      enqueuedAt: new Date().toISOString(),
      ...(continues ? { continuation: true as const } : {})
    });
    await repositories.fingerprintSweeps.markDispatched(runId, new Date());
  };
}

/**
 * Picks up fingerprint work a previous process left behind: queues the next
 * cycle of every sweep chain it stranded, re-enqueues every run still waiting
 * for admission, and dispatches every run that was admitted but never sent
 * back to discovery.
 */
async function drainFingerprintBacklog(
  context: WorkerContext,
  dispatch: (runId: string) => Promise<void>
): Promise<void> {
  const { repositories, queue, logger } = context;
  const recovered = await recoverStrandedContinuations(repositories, queue);
  if (recovered > 0) {
    logger?.info({ event: "fingerprint_continuations_recovered", recovered });
  }
  for (let offset = 0; ;) {
    const waitingFingerprintRuns =
      await repositories.fingerprintSweeps.listWaiting(100, offset);
    for (const runId of waitingFingerprintRuns) {
      await queue.enqueueFingerprintAdmission(runId);
    }
    if (waitingFingerprintRuns.length < 100) break;
    offset += waitingFingerprintRuns.length;
  }
  for (;;) {
    const admittedFingerprintRuns =
      await repositories.fingerprintSweeps.listAdmittedUndispatched(100);
    if (admittedFingerprintRuns.length === 0) break;
    for (const runId of admittedFingerprintRuns) {
      await dispatch(runId);
    }
  }
}

/** One fingerprint admission attempt, dispatching the run once admitted. */
function fingerprintAdmissionWork(
  context: WorkerContext,
  dispatch: (runId: string) => Promise<void>
): (runId: string) => Promise<void> {
  const { repositories, clock, logger } = context;
  return async (runId) => {
    // One record per admission attempt, whatever it decided. The run id
    // stays out: the outcome and the time taken are what show a slow cycle.
    const startedAt = clock();
    let outcome: string | undefined;
    let failure: string | undefined;
    try {
      const admission = await repositories.fingerprintSweeps.admitWaiting(
        runId,
        new Date()
      );
      outcome = admission.kind;
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
      await dispatch(runId);
    } catch (error) {
      // A waiting run throws only to ask the queue for a later retry; that
      // is the outcome working, not a failure.
      if (outcome !== "waiting") failure = errorName(error);
      throw error;
    } finally {
      logger?.info({
        event: "fingerprint_admission",
        ...(outcome === undefined ? {} : { outcome }),
        durationMs: elapsedMs(clock, startedAt),
        ...(failure === undefined ? {} : { errorName: failure })
      });
    }
  };
}

/**
 * What actually drives a waiting run. `reserve` is otherwise reached only
 * from a dossier read or the refresh endpoint, so a run that deferred itself
 * resumed only when somebody happened to load the page — which made the
 * dossier nobody was watching the one that quietly never finished.
 *
 * It only reserves and enqueues. The evidence queue still collects one run at
 * a time and the points gate still refuses a run it cannot afford, so this
 * cannot spend more per hour than a reader already could.
 */
async function evidenceResumeSweep(context: WorkerContext): Promise<void> {
  const { config, pool, repositories, queue, clock, logger } = context;
  const sweepStartedAt = clock();
  // The backlog over time (#509). It rides this five-minute tick because
  // the cadence is modest and the tick already runs on every worker, and
  // it samples before the sweep enqueues anything of its own. Guarded like
  // recovery below: a failed read must never cost the sweep.
  try {
    logger?.info({
      event: "queue_depth",
      queues: await readQueueDepths(pool)
    });
  } catch (error) {
    logger?.info({
      event: "queue_depth_failed",
      failure: error instanceof Error ? error.name : "unknown"
    });
  }
  // A sweep chain can strand without a restart too: an admitted cycle whose
  // discovery job was deduplicated onto the still-running cycle that queued
  // it never runs, and its chain becomes recoverable once that reservation
  // expires. Guarded for the same reason as the reads around it.
  try {
    const recovered = await recoverStrandedContinuations(repositories, queue);
    if (recovered > 0) {
      logger?.info({ event: "fingerprint_continuations_recovered", recovered });
    }
  } catch (error) {
    logger?.info({
      event: "fingerprint_continuation_recovery_failed",
      failure: error instanceof Error ? error.name : "unknown"
    });
  }
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
      queue,
      {
        startedBefore: new Date(
          Date.now() - ABANDONED_EVIDENCE_RUN_RETENTION_MS
        ),
        reservedBefore: new Date(Date.now() - ORPHANED_EVIDENCE_RESERVATION_MS),
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
  let resumed: number;
  try {
    resumed = await resumeWaitingEvidence(repositories.evidence, queue, {
      freshnessCutoff: new Date(
        Date.now() - config.evidenceFreshnessHours * 60 * 60 * 1000
      ),
      limit: config.evidenceResumeSweepLimit,
      ...(logger ? { logger } : {})
    });
  } catch (error) {
    // Still rethrown for the queue's one retry, but no longer silent.
    logger?.info({
      event: "evidence_resume_sweep",
      released,
      republished,
      durationMs: elapsedMs(clock, sweepStartedAt),
      errorName: errorName(error)
    });
    throw error;
  }
  // Counts only, never a character key -- recovery reads one now, to mark
  // the tiers a republished stage earned, and it must not leak here. This
  // says whether the sweep is doing anything, which is the thing that was
  // impossible to tell before it existed.
  logger?.info({
    event: "evidence_resume_sweep",
    resumed,
    released,
    republished,
    durationMs: elapsedMs(clock, sweepStartedAt)
  });
}

type ApplicantSheet = ReturnType<typeof createApplicantSheetClient>;

function createApplicantSheet(config: WorkerConfig): ApplicantSheet | null {
  if (!config.applicantWatcher.enabled) return null;
  return config.applicantWatcher.apiKey
    ? createApplicantSheetClient({
        sheetId: config.applicantWatcher.sheetId!,
        column: config.applicantWatcher.column,
        apiKey: config.applicantWatcher.apiKey
      })
    : createApplicantSheetClient({
        sheetId: config.applicantWatcher.sheetId!,
        column: config.applicantWatcher.column,
        email: config.applicantWatcher.serviceAccountEmail!,
        privateKey: config.applicantWatcher.privateKey!
      });
}

/**
 * One applicant watcher tick: poll the Sheet when it is due, then drain the
 * intents it has recorded. The returned tick keeps the poll's backoff and
 * alert throttling between calls, and never throws: a failure anywhere is
 * logged with how long the tick ran.
 */
function createApplicantSheetTick(
  context: WorkerContext,
  applicantSheet: ApplicantSheet,
  handlers: Pick<
    WorkerHandlers,
    "gateway" | "evidenceGateway" | "fingerprintAlertNotifier"
  >
): () => Promise<void> {
  const { config, pool, repositories, queue, clock, logger } = context;
  const { gateway, evidenceGateway, fingerprintAlertNotifier } = handlers;
  let applicantPollFailures = 0;
  let applicantNextPollAttempt = 0;
  let applicantAlertedAt = 0;

  async function pollSheet(): Promise<void> {
    const pollStartedAt = clock();
    try {
      let numericChecks = 0;
      let numericAllowance: boolean | undefined;
      const resolvedDossiers = new Map<string, string>();
      const poll = await pollApplicantSheet({
        pool: pool as Pool,
        readRows: () => applicantSheet.readRows(),
        resolveDossierPath: (identity) => resolvedDossiers.get(identity),
        isSuppressed: async (identity, observedAt) => {
          const decoded = decodeApplicantIdentity(identity);
          if (decoded.kind === "warcraftlogs_id") {
            if (++numericChecks > 4 || !evidenceGateway.resolveCharacterById)
              return "defer";
            try {
              if (numericAllowance === undefined) {
                const allowance = await evidenceGateway.getRateLimit();
                numericAllowance =
                  allowance.kind === "rate_limit" &&
                  allowance.limitPerHour - allowance.pointsSpentThisHour >=
                    config.applicantWatcher.minimumPoints;
              }
              if (!numericAllowance) return "defer";
              const resolved = await evidenceGateway.resolveCharacterById(
                decoded.id
              );
              if (resolved.kind !== "identity") return "defer";
              resolvedDossiers.set(
                identity,
                `/dossiers/${resolved.key.region}/${resolved.key.realm}/${encodeURIComponent(resolved.key.name)}`
              );
              return wasSuppressedAt(pool as Pool, resolved.key, observedAt);
            } catch {
              return "defer";
            }
          }
          return wasSuppressedAt(pool as Pool, decoded.key, observedAt);
        },
        backlogLimit: config.applicantWatcher.backlog
      });
      applicantPollFailures = 0;
      applicantNextPollAttempt = 0;
      logger?.info({
        event: "applicant_sheet_poll",
        baseline: poll.baseline,
        rebaselined: poll.rebaselined,
        created: poll.created,
        backlog: poll.backlog,
        invalid: poll.invalid,
        truncated: poll.truncated,
        durationMs: elapsedMs(clock, pollStartedAt)
      });
      await announceNewApplicantIntents(
        poll,
        fingerprintAlertNotifier,
        logger,
        config.applicantWatcher.dossierBaseUrl
      );
      if (poll.truncated > 0 && Date.now() - applicantAlertedAt > 3_600_000) {
        applicantAlertedAt = Date.now();
        await fingerprintAlertNotifier?.notify({
          event: "applicant_input_truncated",
          details: { cells: poll.truncated }
        });
      }
      if (
        poll.backlog >= Math.ceil(config.applicantWatcher.backlog * 0.8) &&
        Date.now() - applicantAlertedAt > 3_600_000
      ) {
        applicantAlertedAt = Date.now();
        await fingerprintAlertNotifier?.notify({
          event: "applicant_backlog_pressure",
          details: {
            backlog: poll.backlog,
            limit: config.applicantWatcher.backlog
          }
        });
      }
    } catch (error) {
      applicantPollFailures++;
      applicantNextPollAttempt =
        Date.now() +
        Math.min(
          3_600_000,
          config.applicantWatcher.cadenceMs *
            2 ** Math.min(applicantPollFailures, 4)
        );
      logger?.info({
        event: "applicant_sheet_poll_failed",
        failures: applicantPollFailures,
        durationMs: elapsedMs(clock, pollStartedAt),
        errorName: errorName(error)
      });
      if (
        applicantPollFailures >= 3 &&
        Date.now() - applicantAlertedAt > 3_600_000
      ) {
        applicantAlertedAt = Date.now();
        await fingerprintAlertNotifier?.notify({
          event: "applicant_poll_failed",
          details: { failures: applicantPollFailures }
        });
      }
    }
  }

  return async () => {
    // Outside the try, so a tick that fails anywhere -- the due check, the
    // poll's alerts or the drain -- still reports how long it ran.
    const tickStartedAt = clock();
    try {
      const due = await pool.query(
        "SELECT last_polled_at FROM applicant_source_state WHERE source = $1",
        ["applicant_sheet"]
      );
      const last = due.rows[0]?.last_polled_at;
      if (
        (Date.now() >= applicantNextPollAttempt && !last) ||
        (Date.now() >= applicantNextPollAttempt &&
          Date.now() - new Date(last as string).getTime() >=
            config.applicantWatcher.cadenceMs)
      ) {
        await pollSheet();
      }
      const drainStartedAt = clock();
      const wcl = evidenceGateway;
      if (!wcl.resolveCharacterById)
        throw new Error("applicant_resolver_unavailable");
      const drained = await drainApplicantIntents({
        pool: pool as Pool,
        config,
        repositories,
        queue,
        raiderio: gateway,
        warcraftlogs: {
          getRateLimit: wcl.getRateLimit,
          resolveCharacterById: wcl.resolveCharacterById
        }
      });
      logger?.info({
        event: "applicant_sheet_drain",
        ...drained,
        durationMs: elapsedMs(clock, drainStartedAt)
      });
    } catch (error) {
      logger?.info({
        event: "applicant_sheet_tick_failed",
        durationMs: elapsedMs(clock, tickStartedAt),
        errorName: errorName(error)
      });
    }
  };
}

/** The hourly cleanup of expired caches, stale credentials and old costs. */
async function cacheCleanup(context: WorkerContext): Promise<void> {
  const { repositories, queue, clock, logger } = context;
  const startedAt = clock();
  let removedEvidenceRuns: number | undefined;
  let removedCollectionStages: number | undefined;
  let removedRunCosts: number | undefined;
  // On the injected logger rather than console.info: this record passes
  // through the worker's redaction like every other one. It carries counts
  // only — never a credential, a run id or a character key. It is written
  // once the whole cycle has run, so its duration covers the search
  // recovery too, and a failed cycle still reports what it had removed.
  const record = (failure?: unknown) =>
    logger?.info({
      event: "evidence_cache_cleanup",
      removedEvidenceRuns,
      removedCollectionStages,
      removedRunCosts,
      durationMs: elapsedMs(clock, startedAt),
      ...(failure === undefined ? {} : { errorName: errorName(failure) })
    });
  try {
    await cleanupExpired(repositories);
    removedEvidenceRuns = await repositories.evidence.clearStaleCredentials({
      settled: new Date(Date.now() - STALE_EVIDENCE_CREDENTIAL_RETENTION_MS),
      active: new Date(
        Date.now() - STALE_ACTIVE_EVIDENCE_CREDENTIAL_RETENTION_MS
      )
    });
    // A stage belongs to an attempt in flight. One whose run has settled
    // is work nothing will ever republish, so it is dropped rather than
    // left to hold a copy of the evidence indefinitely.
    removedCollectionStages =
      await repositories.evidence.clearSettledCollectionStages();
    removedRunCosts = await repositories.evidence.clearExpiredRunCosts(
      new Date(Date.now() - EVIDENCE_RUN_COST_RETENTION_MS)
    );
    await recoverPendingSearches(repositories, queue);
  } catch (error) {
    record(error);
    throw error;
  }
  record();
}

/** How long one maintenance cycle may spend recomputing character groups (#738). */
const CHARACTER_GROUPS_RECOMPUTE_BUDGET_MS = 30_000;

/**
 * The hourly maintenance: the existing cache cleanup, then the character
 * groups recompute. The recompute runs even when the cleanup failed, and a
 * recompute failure never hides the cleanup's own.
 */
async function maintenanceCleanup(context: WorkerContext): Promise<void> {
  try {
    await cacheCleanup(context);
  } finally {
    await characterGroupsRecompute(context);
  }
}

async function characterGroupsRecompute(context: WorkerContext): Promise<void> {
  const { repositories, clock, logger } = context;
  const connections = repositories.characterConnections;
  if (!connections) return;
  const startedAt = clock();
  try {
    const result = await connections.recomputePass({
      budgetMs: CHARACTER_GROUPS_RECOMPUTE_BUDGET_MS
    });
    logger?.info({
      event: "character_groups_recompute",
      ...result,
      durationMs: elapsedMs(clock, startedAt)
    });
  } catch (error) {
    const errorCode = characterGroupsErrorCode(error);
    logger?.info({
      event: "character_groups_write_failed",
      // Nothing was written here, so no write was lost: the next
      // maintenance cycle recomputes what this one missed.
      stage: "recompute",
      errorName: errorName(error),
      ...(errorCode === undefined ? {} : { errorCode }),
      durationMs: elapsedMs(clock, startedAt)
    });
  }
}

export async function createWorkerRuntime(
  config: WorkerConfig,
  dependencies: WorkerRuntimeDependencies = defaultDependencies,
  logger?: DiscoveryLogger
): Promise<WorkerRuntime> {
  const pool = dependencies.createPool(config.databaseUrl);
  const clock = dependencies.clock ?? monotonicClock;
  let queue: DiscoveryQueue | undefined;
  let ready = false;
  let stopping: Promise<void> | undefined;
  let mailWorker: ReturnType<typeof startAccountMailWorker> | undefined;

  try {
    await connectWithRetry(pool, config, dependencies.sleep);
    await dependencies.runMigrations(pool);
    const repositories = dependencies.createRepositories(pool);
    const initializedQueue = dependencies.createQueue(config.databaseUrl);
    queue = initializedQueue;
    const context: WorkerContext = {
      config,
      pool,
      repositories,
      queue: initializedQueue,
      clock,
      logger
    };
    const applicantSheet = createApplicantSheet(config);
    const handlers = buildHandlers(context, dependencies);
    const applicantSheetTick = applicantSheet
      ? createApplicantSheetTick(context, applicantSheet, handlers)
      : null;

    await initializedQueue.start();
    await recoverPendingSearches(repositories, initializedQueue);
    const dispatchAdmittedFingerprintRun = fingerprintRunDispatcher(context);
    await drainFingerprintBacklog(context, dispatchAdmittedFingerprintRun);
    await initializedQueue.workFingerprintAdmissions(
      fingerprintAdmissionWork(context, dispatchAdmittedFingerprintRun)
    );
    await initializedQueue.scheduleEvidenceResume(async () => {
      await evidenceResumeSweep(context);
      await applicantSheetTick?.();
    });
    await initializedQueue.scheduleMaintenanceCleanup(() =>
      maintenanceCleanup(context)
    );
    await initializedQueue.work(async (payload, workContext) => {
      await attributeThrottlesTo({ runId: payload.runId }, () =>
        handlers.handler.execute(
          payload.runId,
          {
            ...workContext,
            correlationId: payload.correlationId,
            enqueuedAt: payload.enqueuedAt
          },
          payload
        )
      );
    });
    await initializedQueue.workCharacterEvidence(
      async (payload, workContext) => {
        await attributeThrottlesTo({ runId: payload.runId }, () =>
          handlers.evidenceHandler.execute(payload, workContext)
        );
      }
    );
    if (config.accountMail) {
      mailWorker = (
        dependencies.startAccountMailWorker ?? startAccountMailWorker
      )(repositories.accountMail, config.accountMail, logger);
    }
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
            // Start both drains before awaiting either. Storage stays available
            // until both settle; a mail timeout must not delay evidence aborts.
            const drained = await Promise.allSettled([
              mailWorker?.stop(config.workerDrainTimeoutMs),
              initializedQueue.stop({
                graceful: true,
                timeoutMs: config.workerDrainTimeoutMs,
                // Waiting out the whole budget was the bug: an evidence run
                // cannot finish inside it, so the wait only ever expired. The
                // grace covers a job that is nearly done; past it the run is
                // aborted, and the handler releases it with the remainder.
                abortGraceMs: config.workerAbortGraceMs
              })
            ]);
            const failed = drained.find(
              (result) => result.status === "rejected"
            );
            if (failed?.status === "rejected") throw failed.reason;
          } catch (error) {
            if (
              error instanceof DiscoveryQueueStopTimeoutError ||
              error instanceof AccountMailStopTimeoutError
            ) {
              // Pool.end drains checked-out clients; initiating it must not
              // turn the already-expired shutdown budget into another wait.
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
    await mailWorker?.stop();
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
