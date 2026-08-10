import type { CharacterKey } from "@slashwho/domain";
import { PgBoss } from "pg-boss";

export const discoverCharacterQueueName = "discover-character";
export const maintenanceCleanupQueueName = "maintenance-cleanup";
export const fingerprintAdmissionQueueName = "fingerprint-admission";

export type DiscoverCharacterJob = {
  runId: string;
  key: CharacterKey;
};

type FingerprintAdmissionJob = {
  runId: string;
};

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
  work(
    handler: (
      payload: DiscoverCharacterJob,
      context: DiscoveryWorkContext
    ) => Promise<void>
  ): Promise<void>;
  workFingerprintAdmissions(
    handler: (runId: string) => Promise<void>
  ): Promise<void>;
  scheduleMaintenanceCleanup(handler: () => Promise<void>): Promise<void>;
  stop(options: { graceful: boolean; timeoutMs: number }): Promise<void>;
  isReady(): boolean;
}

export type CreateDiscoveryQueueOptions = {
  connectionString: string;
};

const queueOptions = {
  retryLimit: 4,
  retryDelay: 1,
  retryBackoff: true,
  retryDelayMax: 1_800,
  expireInSeconds: 1_800
} as const;

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
  let ready = false;
  let maintenanceRegistered = false;
  let fingerprintAdmissionsRegistered = false;
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
      await boss.updateQueue(fingerprintAdmissionQueueName, {
        retryLimit: 2_147_483_647,
        retryDelay: 60,
        expireInSeconds: 300
      });
      acceptingFingerprintAdmissions = true;
      ready = true;
    },

    async enqueue(payload) {
      if (!ready) throw new Error("discovery_queue_not_ready");
      const id = await boss.send(discoverCharacterQueueName, payload, {
        singletonKey: payload.runId
      });
      return id ??
        (await existingSingletonJobId(discoverCharacterQueueName, payload.runId)) ??
        (() => {
          throw new Error("discovery_queue_enqueue_not_created");
        })();
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
      return id ??
        (await existingSingletonJobId(fingerprintAdmissionQueueName, runId)) ??
        (() => {
          throw new Error("fingerprint_admission_enqueue_not_created");
        })();
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
                signal: job.signal
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

    async stop({ graceful, timeoutMs }) {
      ready = false;
      maintenanceRegistered = false;
      fingerprintAdmissionsRegistered = false;
      acceptingFingerprintAdmissions = false;
      let stopError: unknown;
      try {
        await boss.stop({ graceful, timeout: timeoutMs });
      } catch (error) {
        stopError = error;
      }
      await settleInFlight(timeoutMs);
      if (stopError) throw stopError;
    },

    isReady() {
      return ready;
    }
  };
}
