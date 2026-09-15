import { describe, expect, it, vi } from "vitest";

const queueFakes = vi.hoisted(() => {
  const workers: Array<{
    name: string;
    handler: (jobs: Array<{ data: { runId: string } }>) => Promise<void>;
  }> = [];
  const db = {
    executeSql: vi.fn(async () => ({ rows: [] }))
  };
  return {
    createQueue: vi.fn(async () => {}),
    updateQueue: vi.fn(async () => {}),
    send: vi.fn<(...args: unknown[]) => Promise<string>>(async () => "job-id"),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    work: vi.fn(async (name, _options, handler) => {
      workers.push({ name, handler });
    }),
    getDb: vi.fn(() => db),
    db,
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
  collectCharacterEvidenceQueueName,
  discoverCharacterQueueName,
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
  it("uses separate generated job ids while retaining a per-run singleton key", async () => {
    // Break caught: admission work could be duplicated or leak a discovery payload into the private queue.
    const queue = createDiscoveryQueue({
      connectionString: "postgres://worker:secret@database/slashwho"
    });
    const runId = "00000000-0000-4000-8000-000000000004";
    const delivered: string[] = [];

    await queue.start();
    await queue.enqueue({
      runId,
      key: { region: "eu", realm: "silvermoon", name: "root" }
    });
    await queue.enqueueFingerprintAdmission(runId);
    await queue.workFingerprintAdmissions(async (deliveredRunId) => {
      delivered.push(deliveredRunId);
    });

    const worker = queueFakes.workers.find(
      ({ name }) => name === fingerprintAdmissionQueueName
    );
    await worker?.handler([
      {
        data: { runId },
        retryCount: 0,
        retryLimit: 4,
        signal: new AbortController().signal
      } as never
    ]);

    expect(queueFakes.createQueue).toHaveBeenCalledWith(
      fingerprintAdmissionQueueName,
      expect.any(Object)
    );
    expect(queueFakes.send).toHaveBeenCalledWith(
      fingerprintAdmissionQueueName,
      { runId },
      { singletonKey: runId }
    );
    expect(queueFakes.send).toHaveBeenCalledWith(
      discoverCharacterQueueName,
      expect.objectContaining({ runId }),
      { singletonKey: runId }
    );
    expect(delivered).toEqual([runId]);

    await queue.stop({ graceful: true, timeoutMs: 1 });
    await worker?.handler([
      {
        data: { runId },
        retryCount: 0,
        retryLimit: 4,
        signal: new AbortController().signal
      } as never
    ]);
    expect(delivered).toEqual([runId]);
  });
});

describe("character evidence queue", () => {
  it("delivers one singleton evidence scan per evidence run", async () => {
    // Break caught: duplicate dossier reads could fan out into concurrent WCL
    // scans for the same durable evidence run.
    const queue = createDiscoveryQueue({
      connectionString: "postgres://worker:secret@database/slashwho"
    });
    const runId = "00000000-0000-4000-8000-000000000005";
    const delivered: Array<{ runId: string; attempt: number }> = [];

    await queue.start();
    await queue.enqueueCharacterEvidence(runId);
    await queue.workCharacterEvidence(async (payload, context) => {
      delivered.push({ runId: payload.runId, attempt: context.attempt });
    });

    const worker = queueFakes.workers.find(
      ({ name }) => name === collectCharacterEvidenceQueueName
    );
    await worker?.handler([
      {
        data: { runId },
        retryCount: 0,
        retryLimit: 4,
        signal: new AbortController().signal
      } as never
    ]);

    expect(queueFakes.createQueue).toHaveBeenCalledWith(
      collectCharacterEvidenceQueueName,
      expect.objectContaining({ policy: "exclusive" })
    );
    expect(queueFakes.work).toHaveBeenCalledWith(
      collectCharacterEvidenceQueueName,
      expect.objectContaining({ localConcurrency: 3 }),
      expect.any(Function)
    );
    expect(queueFakes.send).toHaveBeenCalledWith(
      collectCharacterEvidenceQueueName,
      { runId },
      { singletonKey: runId }
    );
    expect(delivered).toEqual([{ runId, attempt: 1 }]);
  });
});

describe("job telemetry", () => {
  it("carries correlation and enqueue time on the discovery payload", async () => {
    const queue = createDiscoveryQueue({
      connectionString: "postgres://worker:secret@database/slashwho"
    });
    await queue.start();
    queueFakes.send.mockClear();

    await queue.enqueue({
      runId: "00000000-0000-4000-8000-000000000010",
      key: { region: "eu", realm: "silvermoon", name: "root" },
      correlationId: "c1",
      enqueuedAt: "2026-09-15T10:00:00.000Z"
    });

    expect(queueFakes.send.mock.calls[0]?.[1]).toMatchObject({
      correlationId: "c1",
      enqueuedAt: "2026-09-15T10:00:00.000Z"
    });
  });

  it("keeps the singleton key on the run id alone", async () => {
    // Break caught: keying deduplication on the correlation id would let one
    // character be discovered once per requester.
    const queue = createDiscoveryQueue({
      connectionString: "postgres://worker:secret@database/slashwho"
    });
    const runId = "00000000-0000-4000-8000-000000000011";
    await queue.start();
    queueFakes.send.mockClear();

    await queue.enqueue({
      runId,
      key: { region: "eu", realm: "silvermoon", name: "root" },
      correlationId: "c1"
    });

    expect(queueFakes.send.mock.calls[0]?.[2]).toMatchObject({
      singletonKey: runId
    });
  });

  it("carries correlation and enqueue time on the evidence payload", async () => {
    const queue = createDiscoveryQueue({
      connectionString: "postgres://worker:secret@database/slashwho"
    });
    await queue.start();
    queueFakes.send.mockClear();

    await queue.enqueueCharacterEvidence(
      "00000000-0000-4000-8000-000000000012",
      { correlationId: "c2", enqueuedAt: "2026-09-15T10:00:01.000Z" }
    );

    expect(queueFakes.send.mock.calls[0]?.[1]).toMatchObject({
      correlationId: "c2",
      enqueuedAt: "2026-09-15T10:00:01.000Z"
    });
  });

  it("enqueues evidence without metadata", async () => {
    const queue = createDiscoveryQueue({
      connectionString: "postgres://worker:secret@database/slashwho"
    });
    await queue.start();
    queueFakes.send.mockClear();

    await queue.enqueueCharacterEvidence(
      "00000000-0000-4000-8000-000000000013"
    );

    expect(queueFakes.send.mock.calls[0]?.[1]).toEqual({
      runId: "00000000-0000-4000-8000-000000000013"
    });
  });
});
