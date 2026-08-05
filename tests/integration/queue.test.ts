import type { CharacterKey } from "@slashwho/domain";
import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createDiscoveryJobHandler } from "../../packages/application/src";
import {
  createDiscoveryQueue,
  createPostgresRepositories,
  runMigrations
} from "../../packages/database/src";
import { startPostgres } from "./postgres";

const queueName = "discover-character";
const key: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "safe-character"
};

async function eventually(
  predicate: () => Promise<boolean>,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("eventually_timeout");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("durable discovery queue", () => {
  let connectionString: string;
  let applicationPool: Pool;
  let stopPostgres: () => Promise<void>;
  const cleanup: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    const postgres = await startPostgres();
    applicationPool = postgres.pool;
    connectionString = postgres.pool.options.connectionString!;
    stopPostgres = postgres.stop;
    await runMigrations(applicationPool);
  });

  afterEach(async () => {
    await Promise.allSettled(cleanup.splice(0).map((stop) => stop()));
    await applicationPool.query("DELETE FROM pgboss.job WHERE name = $1", [
      queueName
    ]);
  });

  afterAll(async () => {
    await stopPostgres();
  });

  it("delivers one job once across two concurrent worker processes", async () => {
    // Break caught: separate workers could both execute the same durable job.
    const first = createDiscoveryQueue({ connectionString });
    const second = createDiscoveryQueue({ connectionString });
    cleanup.push(
      () => first.stop({ graceful: false, timeoutMs: 1_000 }),
      () => second.stop({ graceful: false, timeoutMs: 1_000 })
    );
    await Promise.all([first.start(), second.start()]);

    let invocationCount = 0;
    let resolveHandled!: () => void;
    const handled = new Promise<void>((resolve) => {
      resolveHandled = resolve;
    });
    const consume = async () => {
      invocationCount += 1;
      resolveHandled();
    };
    await Promise.all([first.work(consume), second.work(consume)]);

    const jobId = await first.enqueue({
      runId: "00000000-0000-4000-8000-000000000001",
      key
    });
    await handled;

    const inspector = new PgBoss(connectionString);
    cleanup.push(() => inspector.stop({ graceful: false, timeout: 1_000 }));
    await inspector.start();
    await eventually(async () => {
      const [job] = await inspector.findJobs(queueName, { id: jobId });
      return job?.state === "completed";
    });

    expect(invocationCount).toBe(1);
  });

  it("deduplicates repeated enqueue for one public run id", async () => {
    // Break caught: enqueue retries could create multiple durable deliveries for one run.
    const queue = createDiscoveryQueue({ connectionString });
    cleanup.push(() => queue.stop({ graceful: false, timeoutMs: 1_000 }));
    await queue.start();
    const payload = {
      runId: "00000000-0000-4000-8000-000000000006",
      key
    };

    const [first, second] = await Promise.all([
      queue.enqueue(payload),
      queue.enqueue(payload)
    ]);

    expect(first).toBe(second);
    const inspector = new PgBoss(connectionString);
    cleanup.push(() => inspector.stop({ graceful: false, timeout: 1_000 }));
    await inspector.start();
    await expect(
      inspector.findJobs(queueName, { id: first })
    ).resolves.toHaveLength(1);
  });

  it("moves a job through created, active, retry, and failed states", async () => {
    // Break caught: failed work could bypass retry or exceed the five-attempt bound.
    const queue = createDiscoveryQueue({ connectionString });
    cleanup.push(() => queue.stop({ graceful: false, timeoutMs: 1_000 }));
    await queue.start();

    const inspector = new PgBoss(connectionString);
    cleanup.push(() => inspector.stop({ graceful: false, timeout: 1_000 }));
    await inspector.start();
    const jobId = await queue.enqueue({
      runId: "00000000-0000-4000-8000-000000000002",
      key
    });
    await expect(inspector.findJobs(queueName, { id: jobId })).resolves.toEqual(
      [expect.objectContaining({ state: "created", retryLimit: 4 })]
    );

    let attempts = 0;
    let releaseFirst!: () => void;
    const firstClaimed = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let unblockFirst!: () => void;
    const firstBlock = new Promise<void>((resolve) => {
      unblockFirst = resolve;
    });
    cleanup.push(async () => unblockFirst());
    await queue.work(async () => {
      attempts += 1;
      if (attempts === 1) {
        releaseFirst();
        await firstBlock;
      }
      throw new Error("controlled_failure");
    });
    await firstClaimed;
    await expect(inspector.findJobs(queueName, { id: jobId })).resolves.toEqual(
      [expect.objectContaining({ state: "active" })]
    );
    unblockFirst();

    await eventually(async () => {
      const [job] = await inspector.findJobs(queueName, { id: jobId });
      return job?.state === "retry";
    });
    await eventually(async () => {
      const [job] = await inspector.findJobs(queueName, { id: jobId });
      return job?.state === "failed";
    }, 40_000);

    const [failed] = await inspector.findJobs(queueName, { id: jobId });
    expect(failed).toMatchObject({
      state: "failed",
      retryCount: 4,
      retryLimit: 4,
      expireInSeconds: 1_800,
      retryBackoff: true,
      retryDelayMax: 1_800
    });
    expect(attempts).toBe(5);
  }, 50_000);

  it("provides durable attempt metadata and cancellation to work", async () => {
    // Break caught: the handler could not distinguish a final delivery or observe shutdown.
    const queue = createDiscoveryQueue({ connectionString });
    cleanup.push(() => queue.stop({ graceful: false, timeoutMs: 1_000 }));
    await queue.start();
    let observed:
      { attempt: number; maxAttempts: number; aborted: boolean } | undefined;
    let handled!: () => void;
    const complete = new Promise<void>((resolve) => {
      handled = resolve;
    });
    await queue.work(async (_payload, context) => {
      if (!context) {
        observed = { attempt: 0, maxAttempts: 0, aborted: false };
        handled();
        return;
      }
      observed = {
        attempt: context.attempt,
        maxAttempts: context.maxAttempts,
        aborted: context.signal.aborted
      };
      handled();
    });

    await queue.enqueue({
      runId: "00000000-0000-4000-8000-000000000007",
      key
    });
    await complete;

    expect(observed).toEqual({ attempt: 1, maxAttempts: 5, aborted: false });
  });

  it("schedules retry no earlier than a longer upstream Retry-After", async () => {
    // Break caught: pg-boss backoff could retry before the application-owned upstream delay.
    const queue = createDiscoveryQueue({ connectionString });
    cleanup.push(() => queue.stop({ graceful: false, timeoutMs: 1_000 }));
    await queue.start();
    const inspector = new PgBoss(connectionString);
    cleanup.push(() => inspector.stop({ graceful: false, timeout: 1_000 }));
    await inspector.start();

    let failedAt = 0;
    await queue.work(async () => {
      failedAt = Date.now();
      throw Object.assign(new Error("discovery_retryable"), {
        retryable: true,
        retryAfterMs: 5_000
      });
    });
    const jobId = await queue.enqueue({
      runId: "00000000-0000-4000-8000-000000000004",
      key
    });

    await eventually(async () => {
      const [job] = await inspector.findJobs(queueName, { id: jobId });
      return job?.state === "retry";
    });
    const [retrying] = await inspector.findJobs(queueName, { id: jobId });
    expect(retrying!.startAfter.getTime()).toBeGreaterThanOrEqual(
      failedAt + 4_900
    );
  });

  it("does not round a fractional application retry directive", async () => {
    // Break caught: the adapter could independently round milliseconds and change the schedule.
    const queue = createDiscoveryQueue({ connectionString });
    cleanup.push(() => queue.stop({ graceful: false, timeoutMs: 1_000 }));
    await queue.start();
    const inspector = new PgBoss(connectionString);
    cleanup.push(() => inspector.stop({ graceful: false, timeout: 1_000 }));
    await inspector.start();

    await queue.work(async () => {
      throw Object.assign(new Error("invalid_fractional_retry_directive"), {
        retryable: true,
        retryAfterMs: 1_500
      });
    });
    const jobId = await queue.enqueue({
      runId: "00000000-0000-4000-8000-000000000008",
      key
    });

    await eventually(async () => {
      const [job] = await inspector.findJobs(queueName, { id: jobId });
      return job?.state === "retry";
    });
    const [retrying] = await inspector.findJobs(queueName, { id: jobId });
    expect(retrying).toMatchObject({
      retryDelay: 1,
      retryBackoff: true,
      retryDelayMax: 1_800
    });
  });

  it("gracefully drains claimed work before stopping", async () => {
    // Break caught: shutdown could return an in-flight job to the queue before its drain window.
    const queue = createDiscoveryQueue({ connectionString });
    cleanup.push(() => queue.stop({ graceful: false, timeoutMs: 1_000 }));
    await queue.start();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    cleanup.push(async () => release());
    let claimed!: () => void;
    const started = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    await queue.work(async () => {
      claimed();
      await blocked;
    });
    const jobId = await queue.enqueue({
      runId: "00000000-0000-4000-8000-000000000005",
      key
    });
    await started;

    let stopped = false;
    const stopping = queue
      .stop({ graceful: true, timeoutMs: 5_000 })
      .then(() => {
        stopped = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stopped).toBe(false);
    release();
    await stopping;

    const inspector = new PgBoss(connectionString);
    cleanup.push(() => inspector.stop({ graceful: false, timeout: 1_000 }));
    await inspector.start();
    await expect(inspector.findJobs(queueName, { id: jobId })).resolves.toEqual(
      [expect.objectContaining({ state: "completed" })]
    );
  });

  it("waits for an aborted handler after the drain timeout", async () => {
    // Break caught: runtime could close its pool while aborted work still unwinds.
    const queue = createDiscoveryQueue({ connectionString });
    cleanup.push(() => queue.stop({ graceful: false, timeoutMs: 1_000 }));
    await queue.start();
    let started!: () => void;
    const claimed = new Promise<void>((resolve) => {
      started = resolve;
    });
    let abortObserved = false;
    let handlerFinished = false;
    let persistenceError: unknown;
    const repositories = createPostgresRepositories(applicationPool);
    const run = await repositories.runs.createOrReuse(
      { region: "eu", realm: "silvermoon", name: "abort-root" },
      "anonymous"
    );
    const handler = createDiscoveryJobHandler({
      repositories,
      requestCap: 12,
      gateway: {
        async getCharacter(_key, signal) {
          started();
          await new Promise<void>((resolve) => {
            signal?.addEventListener(
              "abort",
              () => {
                abortObserved = true;
                setTimeout(resolve, 250);
              },
              { once: true }
            );
          });
          try {
            await applicationPool.query("SELECT pg_sleep(0.1)");
          } catch (error) {
            persistenceError = error;
          }
          return {
            key: { region: "eu", realm: "silvermoon", name: "abort-root" },
            displayName: "Abort Root",
            className: "Mage",
            level: 80,
            ownerId: "owner",
            profileGuess: null,
            declaredMain: null
          };
        },
        async getClaimedCharacters() {
          return [];
        },
        async resolveProfileGuess() {
          return null;
        }
      }
    });
    await queue.work(async (payload, context) => {
      try {
        await handler.execute(payload.runId, context);
      } finally {
        handlerFinished = true;
      }
    });
    await queue.enqueue({
      runId: run.id,
      key
    });
    await claimed;

    await queue.stop({ graceful: true, timeoutMs: 1_000 });

    expect(abortObserved).toBe(true);
    expect(handlerFinished).toBe(true);
    expect(persistenceError).toBeUndefined();
    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "running",
      snapshotId: null,
      errorCode: null
    });
    await expect(
      repositories.snapshots.getCurrent(run.rootKey)
    ).resolves.toBeNull();
    await expect(
      repositories.negativeCache.find(run.rootKey)
    ).resolves.toBeNull();
  });

  it("fails within a second bounded window when aborted work does not settle", async () => {
    // Break caught: a non-cooperative handler could make shutdown wait forever.
    const queue = createDiscoveryQueue({ connectionString });
    cleanup.push(() => queue.stop({ graceful: false, timeoutMs: 1_000 }));
    await queue.start();
    let claimed!: () => void;
    const started = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished!: () => void;
    const handlerFinished = new Promise<void>((resolve) => {
      finished = resolve;
    });
    await queue.work(async () => {
      claimed();
      await blocked;
      finished();
    });
    await queue.enqueue({
      runId: "00000000-0000-4000-8000-000000000009",
      key
    });
    await started;
    const watchdog = setTimeout(release, 4_000);
    const startedAt = Date.now();
    let failure: unknown;

    try {
      await queue.stop({ graceful: true, timeoutMs: 1_000 });
    } catch (error) {
      failure = error;
    } finally {
      release();
      await handlerFinished;
      clearTimeout(watchdog);
    }

    expect(failure).toMatchObject({
      name: "DiscoveryQueueStopTimeoutError",
      code: "discovery_queue_stop_timeout"
    });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });
});
