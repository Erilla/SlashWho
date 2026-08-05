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

function requestedRetryDelaySeconds(error: unknown): number | null {
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
    retryDelaySeconds <= queueOptions.retryDelayMax
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

    async stop({ graceful, timeoutMs }) {
      ready = false;
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
