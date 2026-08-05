import type { CharacterKey } from "@slashwho/domain";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createDiscoveryQueue } from "../../packages/database/src";
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
  let stopPostgres: () => Promise<void>;
  const cleanup: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    const postgres = await startPostgres();
    connectionString = postgres.pool.options.connectionString!;
    stopPostgres = postgres.stop;
  });

  afterEach(async () => {
    await Promise.allSettled(cleanup.splice(0).map((stop) => stop()));
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

  it("gracefully drains claimed work before stopping", async () => {
    // Break caught: shutdown could return an in-flight job to the queue before its drain window.
    const queue = createDiscoveryQueue({ connectionString });
    cleanup.push(() => queue.stop({ graceful: false, timeoutMs: 1_000 }));
    await queue.start();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
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
});
