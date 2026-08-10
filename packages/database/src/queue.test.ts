import { describe, expect, it, vi } from "vitest";

const queueFakes = vi.hoisted(() => {
  const workers: Array<{
    name: string;
    handler: (jobs: Array<{ data: { runId: string } }>) => Promise<void>;
  }> = [];
  return {
    createQueue: vi.fn(async () => {}),
    updateQueue: vi.fn(async () => {}),
    send: vi.fn(async () => "job-id"),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    work: vi.fn(async (name, _options, handler) => {
      workers.push({ name, handler });
    }),
    getDb: vi.fn(),
    workers
  };
});

vi.mock("pg-boss", () => ({
  PgBoss: class {
    start = queueFakes.start;
    stop = queueFakes.stop;
    createQueue = queueFakes.createQueue;
    updateQueue = queueFakes.updateQueue;
    send = queueFakes.send;
    work = queueFakes.work;
    getDb = queueFakes.getDb;
  }
}));

import {
  createDiscoveryQueue,
  fingerprintAdmissionQueueName,
  updateActiveRetryDelay
} from "./queue";

describe("pg-boss retry delay update", () => {
  it("fails safely when the active pg-boss row is not updated", async () => {
    // Break caught: a pg-boss schema/state drift could silently ignore Retry-After.
    const db = {
      async executeSql() {
        return { rows: [] };
      }
    };

    await expect(
      updateActiveRetryDelay(db, "00000000-0000-4000-8000-000000000001", 5)
    ).rejects.toThrow("retry_delay_update_failed");
  });
});

describe("fingerprint admission queue", () => {
  it("uses a per-run singleton job and delivers only its run id", async () => {
    // Break caught: admission work could be duplicated or leak a discovery payload into the private queue.
    const queue = createDiscoveryQueue({
      connectionString: "postgres://worker:secret@database/slashwho"
    });
    const runId = "00000000-0000-4000-8000-000000000004";
    const delivered: string[] = [];

    await queue.start();
    await queue.enqueueFingerprintAdmission(runId);
    await queue.workFingerprintAdmissions(async (deliveredRunId) => {
      delivered.push(deliveredRunId);
    });

    const worker = queueFakes.workers.find(
      ({ name }) => name === fingerprintAdmissionQueueName
    );
    await worker?.handler([{ data: { runId } }]);

    expect(queueFakes.createQueue).toHaveBeenCalledWith(
      fingerprintAdmissionQueueName,
      expect.any(Object)
    );
    expect(queueFakes.send).toHaveBeenCalledWith(
      fingerprintAdmissionQueueName,
      { runId },
      { id: runId, singletonKey: runId }
    );
    expect(delivered).toEqual([runId]);

    await queue.stop({ graceful: true, timeoutMs: 1 });
    await worker?.handler([{ data: { runId } }]);
    expect(delivered).toEqual([runId]);
  });
});
