import type { CharacterKey } from "@slashwho/domain";
import { PgBoss } from "pg-boss";

export const discoverCharacterQueueName = "discover-character";

export type DiscoverCharacterJob = {
  runId: string;
  key: CharacterKey;
};

export type DiscoveryWorkContext = {
  attempt: number;
  maxAttempts: number;
  signal: AbortSignal;
};

export interface DiscoveryQueue {
  start(): Promise<void>;
  enqueue(payload: DiscoverCharacterJob): Promise<string>;
  work(
    handler: (
      payload: DiscoverCharacterJob,
      context: DiscoveryWorkContext
    ) => Promise<void>
  ): Promise<void>;
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

function requestedRetryDelayMs(error: unknown): number | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("retryable" in error) ||
    error.retryable !== true ||
    !("retryAfterMs" in error) ||
    typeof error.retryAfterMs !== "number" ||
    !Number.isFinite(error.retryAfterMs) ||
    error.retryAfterMs < 0
  ) {
    return null;
  }
  return Math.min(error.retryAfterMs, queueOptions.retryDelayMax * 1_000);
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
  retryDelaySeconds: number
): Promise<void> {
  const result = await db.executeSql(
    `UPDATE pgboss.job
     SET retry_delay = $2, retry_backoff = false,
         retry_delay_max = $2
     WHERE id = $1::uuid
       AND name = $3
       AND state = 'active'
     RETURNING id`,
    [jobId, retryDelaySeconds, discoverCharacterQueueName]
  );
  if (result.rows.length !== 1) throw new Error("retry_delay_update_failed");
}

export function createDiscoveryQueue(
  options: CreateDiscoveryQueueOptions
): DiscoveryQueue {
  const boss = new PgBoss(options.connectionString);
  const inFlight = new Set<Promise<void>>();
  let ready = false;

  return {
    async start() {
      await boss.start();
      await boss.createQueue(discoverCharacterQueueName, queueOptions);
      await boss.updateQueue(discoverCharacterQueueName, queueOptions);
      ready = true;
    },

    async enqueue(payload) {
      if (!ready) throw new Error("discovery_queue_not_ready");
      const id = await boss.send(discoverCharacterQueueName, payload, {
        id: payload.runId,
        singletonKey: payload.runId
      });
      return id ?? payload.runId;
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
              const retryDelayMs = requestedRetryDelayMs(error);
              if (retryDelayMs !== null) {
                const retryDelaySeconds = Math.max(
                  1,
                  Math.ceil(retryDelayMs / 1_000)
                );
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

    async stop({ graceful, timeoutMs }) {
      ready = false;
      await boss.stop({ graceful, timeout: timeoutMs });
      await Promise.allSettled([...inFlight]);
    },

    isReady() {
      return ready;
    }
  };
}
