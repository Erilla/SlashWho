import type { CharacterKey } from "@slashwho/domain";
import { PgBoss } from "pg-boss";

export const discoverCharacterQueueName = "discover-character";
export const maintenanceCleanupQueueName = "maintenance-cleanup";
export const fingerprintAdmissionQueueName = "fingerprint-admission";
export const collectCharacterEvidenceQueueName = "collect-character-evidence";
export const evidenceResumeQueueName = "evidence-resume";

/** Optional so jobs enqueued before this deployment stay valid in flight. */
export type JobTelemetry = {
  correlationId?: string;
  /** ISO 8601. Absent yields a null queueWaitMs rather than a wrong one. */
  enqueuedAt?: string;
};

export type DiscoverCharacterJob = {
  runId: string;
  key: CharacterKey;
  /**
   * Set when this job resumes a fingerprint sweep that capped. It skips
   * Raider.IO re-discovery and the completed-run guard.
   */
  continuation?: true;
} & JobTelemetry;

type FingerprintAdmissionJob = {
  runId: string;
};

export type CollectCharacterEvidenceJob = {
  runId: string;
  /**
   * `light` reads only the most recent page of reports, for a manual refresh
   * inside its cooldown. Absent means a full collection.
   */
  mode?: "full" | "light";
} & JobTelemetry;

export type DiscoveryWorkContext = {
  attempt: number;
  maxAttempts: number;
  signal: AbortSignal;
};

export class DiscoveryQueueStopTimeoutError extends Error {
  readonly code = "discovery_queue_stop_timeout" as const;

  constructor() {
    super("discovery queue work did not settle before shutdown deadline");
    this.name = "DiscoveryQueueStopTimeoutError";
  }
}

export interface DiscoveryQueue {
  start(): Promise<void>;
  enqueue(payload: DiscoverCharacterJob): Promise<string>;
  enqueueFingerprintAdmission(runId: string): Promise<string>;
  enqueueCharacterEvidence(
    runId: string,
    meta?: JobTelemetry & { mode?: "full" | "light" }
  ): Promise<string>;
  work(
    handler: (
      payload: DiscoverCharacterJob,
      context: DiscoveryWorkContext
    ) => Promise<void>
  ): Promise<void>;
  workFingerprintAdmissions(
    handler: (runId: string) => Promise<void>
  ): Promise<void>;
  workCharacterEvidence(
    handler: (
      payload: CollectCharacterEvidenceJob,
      context: DiscoveryWorkContext
    ) => Promise<void>
  ): Promise<void>;
  scheduleMaintenanceCleanup(handler: () => Promise<void>): Promise<void>;
  /**
   * Runs `handler` every five minutes, to drive evidence runs whose retry
   * deadline has passed. Separate from the hourly maintenance cleanup because
   * the deadlines it chases are minutes apart: on the hourly cadence every
   * waiting character would sit for up to an extra hour.
   */
  scheduleEvidenceResume(handler: () => Promise<void>): Promise<void>;
  /**
   * The subset of `jobIds` whose evidence job can no longer run: completed,
   * cancelled, failed, or archived out of the job table altogether. A run row
   * still active behind one of these is a run nothing is working on, which is
   * the only way to tell a killed worker's run from one that is simply slow.
   */
  settledEvidenceJobIds(
    jobIds: readonly string[]
  ): Promise<readonly string[]>;
  stop(options: {
    graceful: boolean;
    timeoutMs: number;
    /**
     * How much of `timeoutMs` a still-running job may spend finishing before
     * its signal is aborted. Capped at half the budget: the remainder belongs
     * to the handler's release path, which is the only thing that takes an
     * abandoned run out of the active set. Absent means abort at once.
     */
    abortGraceMs?: number;
  }): Promise<void>;
  isReady(): boolean;
}

export type CreateDiscoveryQueueOptions = {
  connectionString: string;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const queueOptions = {
  retryLimit: 4,
  retryDelay: 1,
  retryBackoff: true,
  retryDelayMax: 1_800,
  expireInSeconds: 1_800
} as const;

const exclusiveQueuePolicyMigration = `
DO $slashwho_queue_upgrade$
BEGIN
  LOCK TABLE pgboss.queue IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE pgboss.job IN SHARE ROW EXCLUSIVE MODE;

  WITH ranked AS (
    SELECT name, id,
      row_number() OVER (
        PARTITION BY name, COALESCE(singleton_key, '')
        ORDER BY (state = 'active') DESC, created_on, id
      ) AS position
    FROM pgboss.job
    WHERE name IN ('discover-character', 'fingerprint-admission', 'collect-character-evidence')
      AND state < 'completed'
  )
  UPDATE pgboss.job AS job
  SET state = 'cancelled', completed_on = now()
  FROM ranked
  WHERE job.name = ranked.name
    AND job.id = ranked.id
    AND ranked.position > 1;

  UPDATE pgboss.job
  SET policy = 'exclusive'
  WHERE name IN ('discover-character', 'fingerprint-admission', 'collect-character-evidence')
    AND state < 'completed'
    AND policy <> 'exclusive';

  UPDATE pgboss.queue
  SET policy = 'exclusive', updated_on = now()
  WHERE name IN ('discover-character', 'fingerprint-admission', 'collect-character-evidence')
    AND policy <> 'exclusive';
END
$slashwho_queue_upgrade$;
`;

function requestedRetryDelaySeconds(
  error: unknown,
  maximumDelaySeconds: number = queueOptions.retryDelayMax
): number | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("retryable" in error) ||
    error.retryable !== true ||
    !("retryAfterMs" in error) ||
    typeof error.retryAfterMs !== "number" ||
    !Number.isFinite(error.retryAfterMs)
  ) {
    return null;
  }
  const retryDelaySeconds = error.retryAfterMs / 1_000;
  return Number.isInteger(retryDelaySeconds) &&
    retryDelaySeconds >= 1 &&
    retryDelaySeconds <= maximumDelaySeconds
    ? retryDelaySeconds
    : null;
}

type SqlExecutor = {
  executeSql(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export async function updateActiveRetryDelay(
  db: SqlExecutor,
  jobId: string,
  retryDelaySeconds: number,
  queueName = discoverCharacterQueueName
): Promise<void> {
  const result = await db.executeSql(
    `UPDATE pgboss.job
     SET retry_delay = $2, retry_backoff = false,
         retry_delay_max = $2
     WHERE id = $1::uuid
       AND name = $3
       AND state = 'active'
     RETURNING id`,
    [jobId, retryDelaySeconds, queueName]
  );
  if (result.rows.length !== 1) throw new Error("retry_delay_update_failed");
}

export function createDiscoveryQueue(
  options: CreateDiscoveryQueueOptions
): DiscoveryQueue {
  const boss = new PgBoss(options.connectionString);
  const inFlight = new Set<Promise<void>>();
  /**
   * Aborted by `stop`, so a shutdown can end work it cannot wait out. Every
   * handler sees this alongside pg-boss's own per-job signal rather than
   * instead of it: that one still carries job expiry and heartbeat failure.
   */
  const shutdown = new AbortController();
  let ready = false;
  let maintenanceRegistered = false;
  let evidenceResumeRegistered = false;
  let fingerprintAdmissionsRegistered = false;
  let characterEvidenceRegistered = false;
  let acceptingFingerprintAdmissions = false;

  async function settleInFlight(timeoutMs: number): Promise<void> {
    const executions = [...inFlight];
    if (executions.length === 0) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new DiscoveryQueueStopTimeoutError()),
        timeoutMs
      );
      timer.unref();
    });
    try {
      await Promise.race([Promise.allSettled(executions), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function existingSingletonJobId(
    queueName: string,
    singletonKey: string
  ): Promise<string | null> {
    const result = await boss.getDb().executeSql(
      `SELECT id::text AS id FROM pgboss.job
       WHERE name = $1 AND singleton_key = $2
         AND state IN ('created', 'retry', 'active')
       ORDER BY created_on DESC LIMIT 1`,
      [queueName, singletonKey]
    );
    const id = result.rows[0]?.id;
    return typeof id === "string" ? id : null;
  }

  return {
    async start() {
      await boss.start();
      await boss.createQueue(discoverCharacterQueueName, {
        ...queueOptions,
        // pg-boss persists this policy and its singleton-key index, so duplicate
        // recovery sends from a restarted worker remain one durable delivery.
        policy: "exclusive"
      });
      await boss.updateQueue(discoverCharacterQueueName, queueOptions);
      await boss.createQueue(fingerprintAdmissionQueueName, {
        policy: "exclusive",
        retryLimit: 2_147_483_647,
        retryDelay: 60,
        expireInSeconds: 300
      });
      await boss.createQueue(collectCharacterEvidenceQueueName, {
        ...queueOptions,
        policy: "exclusive"
      });
      // pg-boss deliberately makes createQueue idempotent and forbids changing
      // policy through updateQueue. Migrate deployed queues and their runnable
      // jobs atomically before this worker accepts sends or registers work.
      await boss.getDb().executeSql(exclusiveQueuePolicyMigration);
      await boss.updateQueue(fingerprintAdmissionQueueName, {
        retryLimit: 2_147_483_647,
        retryDelay: 60,
        expireInSeconds: 300
      });
      await boss.updateQueue(collectCharacterEvidenceQueueName, queueOptions);
      acceptingFingerprintAdmissions = true;
      ready = true;
    },

    async enqueue(payload) {
      if (!ready) throw new Error("discovery_queue_not_ready");
      const singletonKey = payload.continuation
        ? `${payload.runId}:continuation`
        : payload.runId;
      const id = await boss.send(discoverCharacterQueueName, payload, {
        singletonKey
      });
      return (
        id ??
        (await existingSingletonJobId(
          discoverCharacterQueueName,
          singletonKey
        )) ??
        (() => {
          throw new Error("discovery_queue_enqueue_not_created");
        })()
      );
    },

    async enqueueFingerprintAdmission(runId) {
      if (!ready) throw new Error("discovery_queue_not_ready");
      const id = await boss.send(
        fingerprintAdmissionQueueName,
        { runId },
        {
          singletonKey: runId
        }
      );
      return (
        id ??
        (await existingSingletonJobId(fingerprintAdmissionQueueName, runId)) ??
        (() => {
          throw new Error("fingerprint_admission_enqueue_not_created");
        })()
      );
    },

    async enqueueCharacterEvidence(runId, meta) {
      if (!ready) throw new Error("discovery_queue_not_ready");
      const id = await boss.send(
        collectCharacterEvidenceQueueName,
        { runId, ...(meta ?? {}) },
        { singletonKey: runId }
      );
      return (
        id ??
        (await existingSingletonJobId(
          collectCharacterEvidenceQueueName,
          runId
        )) ??
        (() => {
          throw new Error("character_evidence_enqueue_not_created");
        })()
      );
    },

    async work(handler) {
      if (!ready) throw new Error("discovery_queue_not_ready");
      await boss.work<
        DiscoverCharacterJob,
        void,
        { pollingIntervalSeconds: number; includeMetadata: true }
      >(
        discoverCharacterQueueName,
        { pollingIntervalSeconds: 0.5, includeMetadata: true },
        async ([job]) => {
          if (!job) return;
          const execution = (async () => {
            try {
              await handler(job.data, {
                attempt: job.retryCount + 1,
                maxAttempts: job.retryLimit + 1,
                signal: AbortSignal.any([job.signal, shutdown.signal])
              });
            } catch (error) {
              const retryDelaySeconds = requestedRetryDelaySeconds(error);
              if (retryDelaySeconds !== null) {
                await updateActiveRetryDelay(
                  boss.getDb(),
                  job.id,
                  retryDelaySeconds
                );
              }
              throw error;
            }
          })();
          inFlight.add(execution);
          try {
            await execution;
          } finally {
            inFlight.delete(execution);
          }
        }
      );
    },

    async workFingerprintAdmissions(handler) {
      if (!ready) throw new Error("discovery_queue_not_ready");
      if (fingerprintAdmissionsRegistered) return;
      await boss.work<
        FingerprintAdmissionJob,
        void,
        { pollingIntervalSeconds: number; includeMetadata: true }
      >(
        fingerprintAdmissionQueueName,
        { pollingIntervalSeconds: 0.5, includeMetadata: true },
        async ([job]) => {
          if (!job || !acceptingFingerprintAdmissions) return;
          const execution = (async () => {
            try {
              await handler(job.data.runId);
            } catch (error) {
              const retryDelaySeconds = requestedRetryDelaySeconds(
                error,
                86_400
              );
              if (retryDelaySeconds !== null) {
                await updateActiveRetryDelay(
                  boss.getDb(),
                  job.id,
                  retryDelaySeconds,
                  fingerprintAdmissionQueueName
                );
              }
              throw error;
            }
          })();
          inFlight.add(execution);
          try {
            await execution;
          } finally {
            inFlight.delete(execution);
          }
        }
      );
      fingerprintAdmissionsRegistered = true;
    },

    async workCharacterEvidence(handler) {
      if (!ready) throw new Error("discovery_queue_not_ready");
      if (characterEvidenceRegistered) return;
      await boss.work<
        CollectCharacterEvidenceJob,
        void,
        {
          pollingIntervalSeconds: number;
          includeMetadata: true;
          localConcurrency: number;
        }
      >(
        collectCharacterEvidenceQueueName,
        {
          pollingIntervalSeconds: 0.5,
          includeMetadata: true,
          // One run at a time, deliberately. The binding constraint on evidence
          // collection is the hourly Warcraft Logs points allowance, not worker
          // slots: parallel runs do not collect more per hour, they reach the
          // ceiling sooner. On 2026-09-18 three runs at this setting spent the
          // whole 18000-point allowance in eight minutes and produced the same
          // failures faster, not more coverage.
          //
          // Serial execution is also what makes the two points measurements
          // mean anything. The #283 admission check reads the remaining
          // allowance and then acts on it, so it is only sound when no other
          // run can spend between the read and the act; and `pointsSpentByRun`
          // is a before/after delta, so overlapping runs charge their spend to
          // each other.
          //
          // This is per worker instance. One instance runs today, so this is
          // sufficient. Scaling horizontally would reintroduce the race across
          // instances, and that -- not now -- is when a shared reservation
          // stops being premature.
          localConcurrency: 1
        },
        async ([job]) => {
          if (!job) return;
          const execution = (async () => {
            try {
              await handler(job.data, {
                attempt: job.retryCount + 1,
                maxAttempts: job.retryLimit + 1,
                signal: AbortSignal.any([job.signal, shutdown.signal])
              });
            } catch (error) {
              // A points-budget refusal carries how long to wait. Without this
              // the job retries on the 1-second backoff, straight into another
              // refusal, and exhausts retryLimit in seconds.
              const retryDelaySeconds = requestedRetryDelaySeconds(error);
              if (retryDelaySeconds !== null) {
                await updateActiveRetryDelay(
                  boss.getDb(),
                  job.id,
                  retryDelaySeconds,
                  collectCharacterEvidenceQueueName
                );
              }
              throw error;
            }
          })();
          inFlight.add(execution);
          try {
            await execution;
          } finally {
            inFlight.delete(execution);
          }
        }
      );
      characterEvidenceRegistered = true;
    },

    async scheduleMaintenanceCleanup(handler) {
      if (!ready) throw new Error("discovery_queue_not_ready");
      if (maintenanceRegistered) return;
      await boss.createQueue(maintenanceCleanupQueueName, {
        retryLimit: 2,
        retryDelay: 60,
        expireInSeconds: 300
      });
      await boss.updateQueue(maintenanceCleanupQueueName, {
        retryLimit: 2,
        retryDelay: 60,
        expireInSeconds: 300
      });
      await boss.schedule(
        maintenanceCleanupQueueName,
        "0 * * * *",
        {},
        { tz: "UTC" }
      );
      await boss.work(
        maintenanceCleanupQueueName,
        { pollingIntervalSeconds: 0.5 },
        async () => {
          const execution = handler();
          inFlight.add(execution);
          try {
            await execution;
          } finally {
            inFlight.delete(execution);
          }
        }
      );
      maintenanceRegistered = true;
    },

    async scheduleEvidenceResume(handler) {
      if (!ready) throw new Error("discovery_queue_not_ready");
      if (evidenceResumeRegistered) return;
      // A tick only reserves and enqueues, so it is quick and cheap. It is
      // also idempotent -- a tick that does nothing costs one query -- which
      // is why a missed run needs no catching up and one retry is plenty.
      const options = {
        retryLimit: 1,
        retryDelay: 60,
        expireInSeconds: 120
      };
      await boss.createQueue(evidenceResumeQueueName, options);
      await boss.updateQueue(evidenceResumeQueueName, options);
      await boss.schedule(
        evidenceResumeQueueName,
        "*/5 * * * *",
        {},
        {
          tz: "UTC"
        }
      );
      await boss.work(
        evidenceResumeQueueName,
        { pollingIntervalSeconds: 0.5 },
        async () => {
          const execution = handler();
          inFlight.add(execution);
          try {
            await execution;
          } finally {
            inFlight.delete(execution);
          }
        }
      );
      evidenceResumeRegistered = true;
    },

    async settledEvidenceJobIds(jobIds) {
      if (!ready) throw new Error("discovery_queue_not_ready");
      // A non-uuid id would fail the cast and take the whole sweep down with
      // it, so it is left out and answers to the recovery time cutoff instead.
      const candidates = jobIds.filter((id) => uuidPattern.test(id));
      if (candidates.length === 0) return [];
      // The enum ordering (created < retry < active < completed < cancelled <
      // failed) is the same test the queue's own policy migration uses, and
      // `name` narrows the scan to this queue's rows. An id with no row at all
      // -- deleted once its retention elapsed -- is absent from `runnable` and
      // so counts as settled, which is what it is. pg-boss's own expiry path
      // deletes and reinserts a timed-out job under the same id, so a run's
      // recorded job id still matches across every retry.
      const result = await boss.getDb().executeSql(
        `SELECT id::text AS id FROM pgboss.job
         WHERE name = $1 AND id = ANY($2::uuid[]) AND state < 'completed'`,
        [collectCharacterEvidenceQueueName, candidates]
      );
      const runnable = new Set(
        result.rows
          .map((row) => (row as { id?: unknown }).id)
          .filter((id): id is string => typeof id === "string")
      );
      return candidates.filter((id) => !runnable.has(id));
    },

    async stop({ graceful, timeoutMs, abortGraceMs }) {
      ready = false;
      maintenanceRegistered = false;
      evidenceResumeRegistered = false;
      fingerprintAdmissionsRegistered = false;
      characterEvidenceRegistered = false;
      acceptingFingerprintAdmissions = false;
      // The budget is split rather than spent entirely on waiting (#306). An
      // evidence run takes 199-591 seconds, so no realistic drain budget lets
      // one finish; waiting out the whole of it only guaranteed that the
      // handler's release path never ran. Half is the ceiling on the wait, so
      // there is always a remainder for the release itself.
      const graceMs = graceful
        ? Math.min(Math.max(abortGraceMs ?? 0, 0), Math.floor(timeoutMs / 2))
        : 0;
      let stopError: unknown;
      try {
        // pg-boss stops polling immediately and then waits for active jobs, so
        // this is the grace: nothing new is fetched during it, and a job that
        // is nearly done still gets to finish.
        await boss.stop({ graceful, timeout: graceful ? graceMs : timeoutMs });
      } catch (error) {
        stopError = error;
      }
      // Whatever is still running now cannot finish inside this shutdown.
      // Aborting is what gives the handler its one database write -- releasing
      // the run -- instead of dying mid-flight with it left `running`.
      if (!shutdown.signal.aborted) {
        shutdown.abort(new Error("worker_shutdown"));
      }
      // The declared remainder, not the measured one: pg-boss floors its own
      // stop timeout at one second, and a grace shorter than that must not be
      // allowed to eat the window the release needs.
      await settleInFlight(timeoutMs - graceMs);
      if (stopError) throw stopError;
    },

    isReady() {
      return ready;
    }
  };
}
