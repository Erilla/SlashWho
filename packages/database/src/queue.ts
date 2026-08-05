import type { CharacterKey } from "@slashwho/domain";
import { PgBoss } from "pg-boss";

export const discoverCharacterQueueName = "discover-character";

export type DiscoverCharacterJob = {
  runId: string;
  key: CharacterKey;
};

export interface DiscoveryQueue {
  start(): Promise<void>;
  enqueue(payload: DiscoverCharacterJob): Promise<string>;
  work(
    handler: (payload: DiscoverCharacterJob) => Promise<void>
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

export function createDiscoveryQueue(
  options: CreateDiscoveryQueueOptions
): DiscoveryQueue {
  const boss = new PgBoss(options.connectionString);
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
      const id = await boss.send(discoverCharacterQueueName, payload);
      if (!id) throw new Error("discovery_queue_enqueue_failed");
      return id;
    },

    async work(handler) {
      if (!ready) throw new Error("discovery_queue_not_ready");
      await boss.work<DiscoverCharacterJob>(
        discoverCharacterQueueName,
        { pollingIntervalSeconds: 0.5 },
        async ([job]) => {
          if (!job) return;
          try {
            await handler(job.data);
          } catch (error) {
            const retryDelayMs = requestedRetryDelayMs(error);
            if (retryDelayMs !== null) {
              const retryDelaySeconds = Math.max(
                1,
                Math.ceil(retryDelayMs / 1_000)
              );
              await boss.getDb().executeSql(
                `UPDATE pgboss.job
                 SET retry_delay = $2, retry_backoff = false,
                     retry_delay_max = $2
                 WHERE id = $1::uuid
                   AND name = $3
                   AND state = 'active'`,
                [job.id, retryDelaySeconds, discoverCharacterQueueName]
              );
            }
            throw error;
          }
        }
      );
    },

    async stop({ graceful, timeoutMs }) {
      ready = false;
      await boss.stop({ graceful, timeout: timeoutMs });
    },

    isReady() {
      return ready;
    }
  };
}
