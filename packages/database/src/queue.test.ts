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
  DiscoveryQueueStopTimeoutError,
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
      expect.objectContaining({ localConcurrency: 1 }),
      expect.any(Function)
    );
    expect(queueFakes.send).toHaveBeenCalledWith(
      collectCharacterEvidenceQueueName,
      { runId },
      { singletonKey: runId }
    );
    expect(delivered).toEqual([{ runId, attempt: 1 }]);
  });

  it("collects evidence one run at a time", async () => {
    // Break caught: #291. Three runs started within a second of each other on
    // 2026-09-18, each sampled a near-full allowance before any of them had
    // spent anything, and all three were admitted. The #283 admission check
    // reads the budget then acts on it, which only holds while runs are
    // serial. It also makes `pointsSpentByRun` attributable: overlapping runs
    // put each other's spend in every delta, which is how twelve deltas summed
    // to 33,000 against an 18,000 allowance.
    const queue = createDiscoveryQueue({
      connectionString: "postgres://worker:secret@database/slashwho"
    });

    await queue.start();
    await queue.workCharacterEvidence(async () => {});

    expect(queueFakes.work).toHaveBeenCalledWith(
      collectCharacterEvidenceQueueName,
      expect.objectContaining({ localConcurrency: 1 }),
      expect.any(Function)
    );
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

  it("scopes the singleton key so a continuation does not collide", async () => {
    // Break caught: a continuation job keyed on the bare runId would collide
    // with the already-completed cycle-1 job for the same run and be
    // silently dropped by pg-boss's singleton policy.
    const queue = createDiscoveryQueue({
      connectionString: "postgres://worker:secret@database/slashwho"
    });
    const runId = "00000000-0000-4000-8000-000000000014";
    await queue.start();
    queueFakes.send.mockClear();

    await queue.enqueue({
      runId,
      key: { region: "eu", realm: "silvermoon", name: "root" }
    });
    await queue.enqueue({
      runId,
      key: { region: "eu", realm: "silvermoon", name: "root" },
      continuation: true
    });

    expect(
      queueFakes.send.mock.calls.map(
        (call) =>
          (call[2] as { singletonKey?: string } | undefined)?.singletonKey
      )
    ).toEqual([runId, `${runId}:continuation`]);
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

describe("shutdown", () => {
  const connectionString = "postgres://worker:secret@database/slashwho";
  const runId = "00000000-0000-4000-8000-000000000020";

  /**
   * The evidence worker most recently registered. `queueFakes.workers`
   * accumulates across this file, so the first match belongs to an earlier
   * test's closure.
   */
  function latestEvidenceWorker() {
    return queueFakes.workers
      .filter(({ name }) => name === collectCharacterEvidenceQueueName)
      .at(-1);
  }

  function deliver(
    worker: ReturnType<typeof latestEvidenceWorker>,
    signal = new AbortController().signal
  ) {
    return worker?.handler([
      { data: { runId }, retryCount: 0, retryLimit: 4, signal } as never
    ]);
  }

  it("aborts in-flight work instead of spending the whole budget waiting", async () => {
    // Break caught: #306. `stop` waited out its entire drain budget on an
    // evidence run that takes 199-591 seconds, so the handler's abort path --
    // the one thing that releases the run -- never ran on a deploy.
    const queue = createDiscoveryQueue({ connectionString });
    let released = false;

    await queue.start();
    await queue.workCharacterEvidence(
      async (_payload, context) =>
        new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => {
            released = true;
            resolve();
          });
        })
    );
    const execution = deliver(latestEvidenceWorker());

    await queue.stop({ graceful: true, timeoutMs: 1_000, abortGraceMs: 10 });
    await execution;

    expect(released).toBe(true);
  });

  it("spends only the grace on waiting and keeps the rest for the release", async () => {
    // Break caught: handing pg-boss the whole budget leaves nothing for the
    // handler's release write, which is what the abort exists to allow.
    const queue = createDiscoveryQueue({ connectionString });
    await queue.start();
    queueFakes.stop.mockClear();

    await queue.stop({ graceful: true, timeoutMs: 1_000, abortGraceMs: 200 });

    expect(queueFakes.stop).toHaveBeenCalledWith({
      graceful: true,
      timeout: 200
    });
  });

  it("caps the grace at half the budget so a release always has time", async () => {
    // Break caught: a grace configured wider than the drain budget would
    // reproduce #306 exactly -- all waiting, no abort.
    const queue = createDiscoveryQueue({ connectionString });
    await queue.start();
    queueFakes.stop.mockClear();

    await queue.stop({ graceful: true, timeoutMs: 1_000, abortGraceMs: 9_000 });

    expect(queueFakes.stop).toHaveBeenCalledWith({
      graceful: true,
      timeout: 500
    });
  });

  it("aborts at once when the stop is not graceful", async () => {
    // Break caught: the initialization-failure path has no reason to wait, and
    // a job left running there holds a database pool that is about to close.
    const queue = createDiscoveryQueue({ connectionString });
    let released = false;

    await queue.start();
    await queue.workCharacterEvidence(
      async (_payload, context) =>
        new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => {
            released = true;
            resolve();
          });
        })
    );
    const execution = deliver(latestEvidenceWorker());
    queueFakes.stop.mockClear();

    await queue.stop({ graceful: false, timeoutMs: 1_000 });
    await execution;

    expect(queueFakes.stop).toHaveBeenCalledWith({
      graceful: false,
      timeout: 1_000
    });
    expect(released).toBe(true);
  });

  it("still reports a timeout when an aborted job does not settle", async () => {
    // Break caught: swallowing the timeout would report a clean shutdown for a
    // process that is about to be killed mid-run.
    const queue = createDiscoveryQueue({ connectionString });

    await queue.start();
    await queue.workCharacterEvidence(
      async () => new Promise<void>(() => undefined)
    );
    void deliver(latestEvidenceWorker());

    await expect(
      queue.stop({ graceful: true, timeoutMs: 40, abortGraceMs: 10 })
    ).rejects.toBeInstanceOf(DiscoveryQueueStopTimeoutError);
  });

  it("keeps honouring the job's own abort signal", async () => {
    // Break caught: the shutdown signal replacing pg-boss's own would lose the
    // job-expiry and heartbeat-failure aborts it carries.
    const queue = createDiscoveryQueue({ connectionString });
    const expiry = new AbortController();
    let released = false;

    await queue.start();
    await queue.workCharacterEvidence(
      async (_payload, context) =>
        new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => {
            released = true;
            resolve();
          });
        })
    );
    const execution = deliver(latestEvidenceWorker(), expiry.signal);

    expiry.abort(new Error("job_expired"));
    await execution;

    expect(released).toBe(true);
    await queue.stop({ graceful: false, timeoutMs: 10 });
  });
});
