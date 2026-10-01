import type {
  CharacterKey,
  RaiderIoCharacter,
  RaiderIoGateway
} from "@slashwho/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDiscoveryJobHandler,
  recoverStrandedContinuations
} from "../../packages/application/src";
import type {
  BlizzardGateway,
  BlizzardRosterCharacter
} from "../../packages/blizzard/src";
import {
  createPostgresRepositories,
  createDiscoveryQueue,
  runMigrations,
  type Repositories
} from "../../packages/database/src";
import { startPostgres } from "./postgres";

/**
 * A continuation cycle that ends without publishing must leave something the
 * admission job can admit. These drive the real handler against PostgreSQL,
 * because the bug was in the seam between them: the handler re-enqueued a
 * bare admission job, and the repository had no `waiting` row for it to find.
 */
describe("fingerprint continuation retry", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;

  beforeAll(async () => {
    postgres = await startPostgres();
    await runMigrations(postgres.pool);
  });

  beforeEach(async () => {
    await postgres.pool.query(`
      TRUNCATE TABLE fingerprint_sweep_request_events,
        fingerprint_sweep_reservations, fingerprint_sweep_admissions,
        fingerprint_sweep_states, snapshot_characters, snapshots,
        discovery_runs, characters CASCADE;
    `);
  });

  afterAll(async () => {
    await postgres.stop();
  });

  const rootKey: CharacterKey = {
    region: "eu",
    realm: "silvermoon",
    name: "retryroot"
  };

  function raiderIoCharacter(key: CharacterKey): RaiderIoCharacter {
    return {
      key,
      displayName: key.name,
      className: "Mage",
      level: 80,
      ownerId: "owner",
      profileGuess: null,
      declaredMain: null,
      guild: null
    };
  }

  const raiderIo: RaiderIoGateway = {
    async getCharacter(key) {
      return raiderIoCharacter(key);
    },
    async getClaimedCharacters() {
      return { characters: [] };
    },
    async resolveProfileGuess() {
      return null;
    }
  };

  const roster: BlizzardRosterCharacter[] = Array.from(
    { length: 20 },
    (_unused, index) => ({
      key: {
        region: "eu",
        realm: "silvermoon",
        name: `member${String.fromCharCode(97 + index)}`
      },
      displayName: `member${index}`,
      className: "Priest",
      level: 80,
      guild: { name: "Retry Guild", region: "eu", realm: "silvermoon" }
    })
  );

  /**
   * Every candidate read is recorded, so a test can tell where a cycle
   * resumed. `failing` makes every read throw a transient failure.
   */
  function blizzard() {
    const state = {
      failing: false,
      retryAfterMs: 30_000,
      reads: [] as string[]
    };
    const rootFingerprint = new Map(
      Array.from({ length: 200 }, (_unused, index) => [index + 1, index])
    );
    const transient = () =>
      Object.assign(new Error("transient"), {
        kind: "transient",
        retryAfterMs: state.retryAfterMs
      });
    const gateway: BlizzardGateway = {
      async getGuildRoster(_root, _signal, onProfileRequest) {
        if (state.failing) throw transient();
        await onProfileRequest?.();
        return roster;
      },
      async getGuildRosterByIdentity() {
        return [];
      },
      async getAchievementFingerprint(key, _signal, onProfileRequest) {
        if (state.failing) throw transient();
        await onProfileRequest?.();
        if (key.name === rootKey.name) return rootFingerprint;
        state.reads.push(key.name);
        return new Map();
      },
      async getCompletedAchievements() {
        return [];
      }
    };
    return { state, gateway };
  }

  function handler(
    repositories: Repositories,
    blizzardGateway: BlizzardGateway | undefined,
    outcomes: unknown[]
  ) {
    return createDiscoveryJobHandler({
      repositories,
      gateway: raiderIo,
      ...(blizzardGateway
        ? {
            blizzardGateway,
            fingerprint: {
              requestCap: 5,
              hourlyBudget: 1_000,
              cadenceMs: 7 * 24 * 60 * 60 * 1_000,
              minimumCommon: 200,
              minimumIdenticalPercent: 20
            }
          }
        : {}),
      enqueueFingerprintAdmission: async () => {},
      requestCap: 12,
      logger: {
        info(event) {
          if (event.event === "discovery_run") outcomes.push(event.outcome);
        }
      }
    });
  }

  function continuation(runId: string) {
    return {
      runId,
      key: rootKey,
      enqueuedAt: new Date().toISOString(),
      continuation: true as const
    };
  }

  /**
   * Publishes cycle 1 of a capped chain and admits its first continuation, as
   * the admission job would before dispatching it.
   */
  async function admittedContinuation() {
    const repositories = createPostgresRepositories(postgres.pool);
    const upstream = blizzard();
    const outcomes: unknown[] = [];
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await handler(repositories, upstream.gateway, outcomes).execute(run.id);
    expect(outcomes).toEqual(["snapshot"]);
    const cursor = await repositories.fingerprintSweeps.getResumeState(rootKey);
    expect(cursor).not.toBeNull();
    await expect(
      repositories.fingerprintSweeps.admitWaiting(run.id, new Date())
    ).resolves.toEqual({ kind: "admitted" });
    const cycleOneReads = [...upstream.state.reads];
    upstream.state.reads.length = 0;
    return { repositories, upstream, outcomes, run, cursor, cycleOneReads };
  }

  const minutes = 60_000;

  /**
   * The next cycle of a chain whose cycle failed at `failedAt` waits
   * `delayMs`: the admission job is told to come back then, and is admitted
   * once that time has passed.
   */
  async function expectAdmittedOnlyAfter(
    chain: Awaited<ReturnType<typeof admittedContinuation>>,
    failedAt: number,
    delayMs: number
  ) {
    const { repositories, run } = chain;
    if (delayMs > 0) {
      const early = await repositories.fingerprintSweeps.admitWaiting(
        run.id,
        new Date(failedAt + delayMs - 1_000)
      );
      expect(early.kind).toBe("waiting");
      const retryAt = early.kind === "waiting" ? early.retryAt.getTime() : 0;
      expect(retryAt).toBeGreaterThanOrEqual(failedAt + delayMs);
      expect(retryAt).toBeLessThanOrEqual(Date.now() + delayMs);
    }
    await expect(
      repositories.fingerprintSweeps.admitWaiting(
        run.id,
        new Date(Date.now() + delayMs + 1_000)
      )
    ).resolves.toEqual({ kind: "admitted" });
  }

  /**
   * What must follow a failed cycle: after its delay the admission job admits
   * a fresh cycle, and that cycle resumes the sweep where the cursor left it.
   */
  async function expectResumesFromCursor(
    chain: Awaited<ReturnType<typeof admittedContinuation>>,
    failedAt: number,
    delayMs: number
  ) {
    const { repositories, upstream, outcomes, run, cursor, cycleOneReads } =
      chain;
    await expect(
      repositories.fingerprintSweeps.getResumeState(rootKey)
    ).resolves.toEqual(cursor);
    await expectAdmittedOnlyAfter(chain, failedAt, delayMs);

    upstream.state.failing = false;
    upstream.state.reads.length = 0;
    await handler(repositories, upstream.gateway, outcomes).execute(
      run.id,
      undefined,
      continuation(run.id)
    );

    expect(outcomes.at(-1)).toBe("snapshot");
    // It picked up after the candidates cycle 1 swept, not from the start.
    expect(upstream.state.reads.length).toBeGreaterThan(0);
    expect(
      upstream.state.reads.filter((name) => cycleOneReads.includes(name))
    ).toEqual([]);
    const next = await repositories.fingerprintSweeps.getResumeState(rootKey);
    expect(next?.resumeAfter).not.toBe(cursor?.resumeAfter);
  }

  it("admits a fresh cycle after a continuation whose sweep fails", async () => {
    // Break caught: the retry re-enqueued a bare admission job, which found no
    // `waiting` row, settled, and stranded the chain with its cursor set.
    const chain = await admittedContinuation();
    chain.upstream.state.failing = true;

    const failedAt = Date.now();
    await handler(
      chain.repositories,
      chain.upstream.gateway,
      chain.outcomes
    ).execute(chain.run.id, undefined, continuation(chain.run.id));

    expect(chain.outcomes.at(-1)).toBe("continuation_retrying");
    // The first retry backs off two minutes, longer than the 30 s Retry-After.
    await expectResumesFromCursor(chain, failedAt, 2 * minutes);
  });

  it("waits out a Retry-After longer than the back-off", async () => {
    const chain = await admittedContinuation();
    chain.upstream.state.failing = true;
    chain.upstream.state.retryAfterMs = 10 * minutes;

    const failedAt = Date.now();
    await handler(
      chain.repositories,
      chain.upstream.gateway,
      chain.outcomes
    ).execute(chain.run.id, undefined, continuation(chain.run.id));

    expect(chain.outcomes.at(-1)).toBe("continuation_retrying");
    await expectResumesFromCursor(chain, failedAt, 10 * minutes);
  });

  it("admits a fresh cycle after a continuation that throws", async () => {
    const chain = await admittedContinuation();
    const throwing: Repositories = {
      ...chain.repositories,
      snapshots: {
        ...chain.repositories.snapshots,
        amendAndFinishFingerprintSweep: async () => {
          throw new Error("controlled_amend_failure");
        }
      }
    };

    const failedAt = Date.now();
    await handler(throwing, chain.upstream.gateway, chain.outcomes).execute(
      chain.run.id,
      undefined,
      continuation(chain.run.id)
    );

    expect(chain.outcomes.at(-1)).toBe("continuation_retrying");
    await expectResumesFromCursor(chain, failedAt, 2 * minutes);
  });

  it("admits a fresh cycle after a continuation with no sweep configured", async () => {
    // The admitted reservation is never used by a handler that skips the
    // sweep, so it must be released or it reads as a live admission.
    const chain = await admittedContinuation();

    const failedAt = Date.now();
    await handler(chain.repositories, undefined, chain.outcomes).execute(
      chain.run.id,
      undefined,
      continuation(chain.run.id)
    );

    expect(chain.outcomes.at(-1)).toBe("continuation_sweep_unavailable");
    await expectResumesFromCursor(chain, failedAt, 2 * minutes);
  });

  it("still gives up on a chain that keeps failing", async () => {
    const chain = await admittedContinuation();
    chain.upstream.state.failing = true;

    // Each retry waits twice as long as the last, so the four the bound
    // allows span half an hour rather than a few seconds.
    const delays = [2, 4, 8, 16].map((count) => count * minutes);
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      const failedAt = Date.now();
      await handler(
        chain.repositories,
        chain.upstream.gateway,
        chain.outcomes
      ).execute(chain.run.id, undefined, continuation(chain.run.id));
      if (cycle < 5) {
        await expectAdmittedOnlyAfter(chain, failedAt, delays[cycle - 1]!);
      } else {
        await expect(
          chain.repositories.fingerprintSweeps.admitWaiting(
            chain.run.id,
            new Date(Date.now() + 60 * minutes)
          )
        ).resolves.toEqual({ kind: "settled" });
      }
    }

    expect(chain.outcomes.slice(-5)).toEqual([
      "continuation_retrying",
      "continuation_retrying",
      "continuation_retrying",
      "continuation_retrying",
      "continuation_abandoned"
    ]);
    // Recovery leaves an abandoned chain alone too.
    await expect(
      recoverStrandedContinuations(chain.repositories, {
        async enqueueFingerprintAdmission() {
          throw new Error("abandoned chain re-enqueued");
        }
      })
    ).resolves.toBe(0);
  });

  it("recovers a chain interrupted between its release and its re-admission", async () => {
    const chain = await admittedContinuation();
    // The process dies after the failed cycle released its reservation and
    // before it queued the next one.
    const { rows } = await postgres.pool.query<{ id: string }>(
      `SELECT reservation.id
       FROM fingerprint_sweep_reservations reservation
       JOIN fingerprint_sweep_admissions admission
         ON admission.id = reservation.admission_id
       WHERE admission.discovery_run_id = $1
         AND reservation.released_at IS NULL`,
      [chain.run.id]
    );
    await chain.repositories.fingerprintSweeps.release(rows[0]!.id, new Date());
    await expect(
      chain.repositories.fingerprintSweeps.admitWaiting(
        chain.run.id,
        new Date()
      )
    ).resolves.toEqual({ kind: "settled" });

    const enqueued: string[] = [];
    await expect(
      recoverStrandedContinuations(chain.repositories, {
        async enqueueFingerprintAdmission(runId) {
          enqueued.push(runId);
        }
      })
    ).resolves.toBe(1);
    expect(enqueued).toEqual([chain.run.id]);
    // Running it again finds the chain queued, not stranded.
    await expect(
      recoverStrandedContinuations(chain.repositories, {
        async enqueueFingerprintAdmission() {}
      })
    ).resolves.toBe(0);

    // Nothing failed, so there is nothing to wait out.
    await expectResumesFromCursor(chain, Date.now(), 0);
  });

  it("leaves a chain whose cycle is still running alone", async () => {
    const chain = await admittedContinuation();

    await expect(
      recoverStrandedContinuations(chain.repositories, {
        async enqueueFingerprintAdmission() {}
      })
    ).resolves.toBe(0);
  });

  it("upgrades a legacy continuation without reopening its completed run or losing the cursor", async () => {
    const chain = await admittedContinuation();
    const beforeRun = await chain.repositories.runs.find(chain.run.id);
    const beforeSnapshot =
      await chain.repositories.snapshots.getCurrent(rootKey);
    const beforeCursor =
      await chain.repositories.fingerprintSweeps.getResumeState(rootKey);
    const queue = createDiscoveryQueue({
      connectionString: postgres.pool.options.connectionString!
    });
    await queue.start();
    try {
      const legacyId = await queue.enqueue(continuation(chain.run.id));
      await postgres.pool.query(
        "UPDATE pgboss.job SET state = 'active' WHERE id = $1",
        [legacyId]
      );
      await postgres.pool.query(
        `UPDATE fingerprint_sweep_admissions SET attempt_base = NULL,
        dispatch_kind = NULL, execution_max_attempts = NULL
        WHERE discovery_run_id = $1 AND status = 'admitted'`,
        [chain.run.id]
      );
      await chain.repositories.fingerprintDeliveries!.recoverLegacy();
      expect(
        (
          await postgres.pool.query(
            "SELECT state FROM pgboss.job WHERE id = $1",
            [legacyId]
          )
        ).rows[0]?.state
      ).toBe("cancelled");
      await expect(chain.repositories.runs.find(chain.run.id)).resolves.toEqual(
        beforeRun
      );
      await expect(
        chain.repositories.snapshots.getCurrent(rootKey)
      ).resolves.toEqual(beforeSnapshot);
      await expect(
        chain.repositories.fingerprintSweeps.getResumeState(rootKey)
      ).resolves.toEqual(beforeCursor);
      const descriptor =
        (await chain.repositories.fingerprintDeliveries!.descriptor(
          chain.run.id
        ))!;
      expect(descriptor.continuation).toBe(true);
      await chain.repositories.fingerprintDeliveries!.recoverLegacy();
      await expect(
        chain.repositories.fingerprintDeliveries!.descriptor(chain.run.id)
      ).resolves.toEqual(descriptor);
      await queue.work((job, context) =>
        handler(
          chain.repositories,
          chain.upstream.gateway,
          chain.outcomes
        ).execute(job.runId, context, job)
      );
      const resumedId = await queue.enqueue({
        ...continuation(chain.run.id),
        admissionId: descriptor.admissionId
      });
      await expect
        .poll(
          async () =>
            (
              await postgres.pool.query(
                "SELECT state FROM pgboss.job WHERE id = $1",
                [resumedId]
              )
            ).rows[0]?.state,
          { timeout: 5_000 }
        )
        .toBe("completed");
      expect((await chain.repositories.runs.find(chain.run.id))?.status).toBe(
        "complete"
      );
      expect((await chain.repositories.runs.find(chain.run.id))?.attempt).toBe(
        beforeRun?.attempt
      );
      expect(
        (await chain.repositories.fingerprintSweeps.getResumeState(rootKey))
          ?.resumeAfter
      ).not.toBe(beforeCursor?.resumeAfter);
    } finally {
      await queue.stop({ graceful: true, timeoutMs: 1_000 });
    }
  });

  it("keeps immediate ordinary admission owned through active work and a transient retry", async () => {
    const repositories = createPostgresRepositories(postgres.pool);
    const upstream = blizzard();
    const outcomes: unknown[] = [];
    let entered!: () => void;
    let release!: () => void;
    const active = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const gateway: BlizzardGateway = {
      ...upstream.gateway,
      async getGuildRoster() {
        if (++reads === 1) {
          entered();
          await proceed;
          throw { kind: "transient", retryAfterMs: 1 };
        }
        return [];
      }
    };
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const queue = createDiscoveryQueue({
      connectionString: postgres.pool.options.connectionString!
    });
    await queue.start();
    try {
      const work = createDiscoveryJobHandler({
        repositories,
        gateway: raiderIo,
        blizzardGateway: gateway,
        fingerprint: {
          requestCap: 5,
          hourlyBudget: 1000,
          cadenceMs: 7 * 24 * 60 * 60_000,
          minimumCommon: 200,
          minimumIdenticalPercent: 20
        },
        requestCap: 12,
        baseRetryDelayMs: 1,
        logger: {
          info(event) {
            if (event.event === "discovery_run") outcomes.push(event.outcome);
          }
        }
      });
      await queue.work((job, context) => work.execute(job.runId, context, job));
      const jobId = await queue.enqueue({ runId: run.id, key: rootKey });
      await active;
      await expect(
        repositories.fingerprintSweeps.listAdmittedUndispatched(100)
      ).resolves.not.toContain(run.id);
      await expect(
        repositories.fingerprintDeliveries!.descriptor(run.id)
      ).resolves.toBeNull();
      release();
      await expect
        .poll(async () => (await repositories.runs.find(run.id))?.status, {
          timeout: 10_000
        })
        .toBe("complete");
      expect((await repositories.runs.find(run.id))?.attempt).toBe(2);
      expect(reads).toBe(2);
      expect(
        (
          await postgres.pool.query(
            "SELECT state FROM pgboss.job WHERE id = $1",
            [jobId]
          )
        ).rows[0]?.state
      ).toBe("completed");
      expect(
        (
          await postgres.pool.query(
            "SELECT DISTINCT execution_job_id FROM fingerprint_sweep_admissions WHERE discovery_run_id = $1",
            [run.id]
          )
        ).rows
      ).toEqual([{ execution_job_id: jobId }]);
    } finally {
      release();
      await queue.stop({ graceful: true, timeoutMs: 1000 });
    }
  });

  it("delays an identified capped continuation without advancing its cursor", async () => {
    const chain = await admittedContinuation();
    const descriptor =
      (await chain.repositories.fingerprintDeliveries!.descriptor(
        chain.run.id
      ))!;
    const queue = createDiscoveryQueue({
      connectionString: postgres.pool.options.connectionString!
    });
    await queue.start();
    try {
      const capped: BlizzardGateway = {
        ...chain.upstream.gateway,
        async getGuildRoster() {
          throw { kind: "fingerprint_cap_reached" };
        }
      };
      await queue.work((job, context) =>
        handler(chain.repositories, capped, chain.outcomes).execute(
          job.runId,
          context,
          job
        )
      );
      const failedAt = Date.now();
      const jobId = await queue.enqueue({
        ...continuation(chain.run.id),
        admissionId: descriptor.admissionId
      });
      await expect
        .poll(
          async () =>
            (
              await postgres.pool.query(
                "SELECT state FROM pgboss.job WHERE id = $1",
                [jobId]
              )
            ).rows[0]?.state,
          { timeout: 5_000 }
        )
        .toBe("completed");
      await expect(
        chain.repositories.fingerprintSweeps.getResumeState(rootKey)
      ).resolves.toEqual(chain.cursor);
      const state = await postgres.pool.query(
        "SELECT continuation_failures FROM fingerprint_sweep_states"
      );
      expect(state.rows[0]?.continuation_failures).toBe(1);
      await expectAdmittedOnlyAfter(chain, failedAt, 2 * minutes);
    } finally {
      await queue.stop({ graceful: true, timeoutMs: 1_000 });
    }
  });

  it.each(["crash", "concurrent"] as const)(
    "atomically retires a terminal continuation across %s recovery",
    async (mode) => {
      const chain = await admittedContinuation();
      const descriptor =
        (await chain.repositories.fingerprintDeliveries!.descriptor(
          chain.run.id
        ))!;
      const queue = createDiscoveryQueue({
        connectionString: postgres.pool.options.connectionString!
      });
      await queue.start();
      let release!: () => void;
      const proceed = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const committed = new Promise<void>((resolve) => {
        entered = resolve;
      });
      try {
        const jobId = await queue.enqueue({
          ...continuation(chain.run.id),
          admissionId: descriptor.admissionId
        });
        await chain.repositories.fingerprintDeliveries!.execute(
          {
            runId: chain.run.id,
            admissionId: descriptor.admissionId,
            jobId,
            attempt: 5,
            maxAttempts: 5
          },
          async () => {}
        );
        await postgres.pool.query(
          "UPDATE pgboss.job SET state = 'failed', completed_on = now() WHERE id = $1",
          [jobId]
        );
        let held = false;
        const intercepted = new Proxy(postgres.pool, {
          get(target, property) {
            if (property === "connect")
              return async () => {
                const client = await target.connect();
                return new Proxy(client, {
                  get(connection, name) {
                    if (name === "query")
                      return async (sql: string, values?: unknown[]) => {
                        if (
                          mode === "crash" &&
                          sql.includes(
                            "INSERT INTO fingerprint_sweep_admissions"
                          )
                        )
                          throw new Error("successor_write_crash");
                        const result = await connection.query(sql, values);
                        if (
                          mode === "concurrent" &&
                          sql === "COMMIT" &&
                          !held
                        ) {
                          held = true;
                          entered();
                          await proceed;
                        }
                        return result;
                      };
                    const value: unknown = Reflect.get(connection, name);
                    return typeof value === "function"
                      ? (value as (...args: unknown[]) => unknown).bind(
                          connection
                        )
                      : value;
                  }
                });
              };
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function"
              ? (value as (...args: unknown[]) => unknown).bind(target)
              : value;
          }
        });
        const recovery =
          createPostgresRepositories(
            intercepted
          ).fingerprintDeliveries!.recoverTerminal();
        if (mode === "crash") {
          await expect(recovery).rejects.toThrow("successor_write_crash");
          expect(
            (
              await postgres.pool.query(
                "SELECT consumed_at FROM fingerprint_sweep_admissions WHERE id = $1",
                [descriptor.admissionId]
              )
            ).rows[0]?.consumed_at
          ).toBeNull();
          expect(
            (
              await postgres.pool.query(
                "SELECT continuation_failures FROM fingerprint_sweep_states"
              )
            ).rows[0]?.continuation_failures
          ).toBe(0);
          await chain.repositories.fingerprintDeliveries!.recoverTerminal();
          const delayed =
            await chain.repositories.fingerprintSweeps.admitWaiting(
              chain.run.id,
              new Date()
            );
          expect(delayed.kind).toBe("waiting");
          if (delayed.kind === "waiting")
            expect(delayed.retryAt.getTime()).toBeGreaterThan(
              Date.now() + 110_000
            );
        } else {
          await committed;
          await recoverStrandedContinuations(chain.repositories, {
            async enqueueFingerprintAdmission() {}
          });
          await expect(
            chain.repositories.fingerprintSweeps.admitWaiting(
              chain.run.id,
              new Date(Date.now() + 121_000)
            )
          ).resolves.toEqual({ kind: "admitted" });
          const before = (
            await postgres.pool.query(
              `SELECT a.id, a.status, r.id AS reservation_id, r.released_at
          FROM fingerprint_sweep_admissions a JOIN fingerprint_sweep_reservations r ON r.admission_id = a.id
          WHERE a.discovery_run_id = $1 AND a.status = 'admitted'`,
              [chain.run.id]
            )
          ).rows;
          expect(before).toHaveLength(1);
          release();
          await recovery;
          expect(
            (
              await postgres.pool.query(
                `SELECT a.id, a.status, r.id AS reservation_id, r.released_at
          FROM fingerprint_sweep_admissions a JOIN fingerprint_sweep_reservations r ON r.admission_id = a.id
          WHERE a.discovery_run_id = $1 AND a.status = 'admitted'`,
                [chain.run.id]
              )
            ).rows
          ).toEqual(before);
          expect(
            (
              await postgres.pool.query(
                "SELECT count(*)::int AS n FROM fingerprint_sweep_admissions WHERE discovery_run_id = $1",
                [chain.run.id]
              )
            ).rows[0]?.n
          ).toBe(3);
        }
      } finally {
        release();
        await queue.stop({ graceful: true, timeoutMs: 1000 });
      }
    }
  );

  it("retires a crashed continuation and queues its bounded delayed successor", async () => {
    const chain = await admittedContinuation();
    const descriptor =
      (await chain.repositories.fingerprintDeliveries!.descriptor(
        chain.run.id
      ))!;
    const beforeSnapshot =
      await chain.repositories.snapshots.getCurrent(rootKey);
    const queue = createDiscoveryQueue({
      connectionString: postgres.pool.options.connectionString!
    });
    await queue.start();
    try {
      const payload = {
        ...continuation(chain.run.id),
        admissionId: descriptor.admissionId
      };
      const originalId = await queue.enqueue(payload);
      await postgres.pool.query(
        "UPDATE pgboss.job SET retry_count = 4 WHERE id = $1",
        [originalId]
      );
      await queue.work(async (job, context) => {
        await chain.repositories.fingerprintDeliveries!.execute(
          {
            runId: job.runId,
            admissionId: job.admissionId!,
            jobId: context.jobId!,
            attempt: context.attempt,
            maxAttempts: context.maxAttempts
          },
          async () => {
            throw new Error("crash_before_continuation_publication");
          }
        );
      });
      await expect
        .poll(
          async () =>
            (
              await postgres.pool.query(
                "SELECT state FROM pgboss.job WHERE id = $1",
                [originalId]
              )
            ).rows[0]?.state,
          { timeout: 5_000 }
        )
        .toBe("failed");
      await chain.repositories.fingerprintDeliveries!.recoverTerminal();
      const next = await chain.repositories.fingerprintSweeps.admitWaiting(
        chain.run.id,
        new Date()
      );
      expect(next.kind).toBe("waiting");
      if (next.kind === "waiting")
        expect(next.retryAt.getTime()).toBeGreaterThan(Date.now() + 110_000);
      await expect(
        chain.repositories.snapshots.getCurrent(rootKey)
      ).resolves.toEqual(beforeSnapshot);
      expect((await chain.repositories.runs.find(chain.run.id))?.status).toBe(
        "complete"
      );
      const waiting =
        await chain.repositories.fingerprintSweeps.listWaiting(100);
      expect(waiting).toEqual([chain.run.id]);
      await chain.repositories.fingerprintDeliveries!.recoverTerminal();
      const replayId = await queue.enqueue(payload);
      await expect
        .poll(
          async () =>
            (
              await postgres.pool.query(
                "SELECT state FROM pgboss.job WHERE id = $1",
                [replayId]
              )
            ).rows[0]?.state,
          { timeout: 5_000 }
        )
        .toBe("completed");
      await expect(
        chain.repositories.fingerprintSweeps.listWaiting(100)
      ).resolves.toEqual(waiting);
      expect(chain.upstream.state.reads).toEqual([]);
    } finally {
      await queue.stop({ graceful: true, timeoutMs: 1_000 });
    }
  });

  it.each(["next_cycle", "sealed"])(
    "rejects a terminal continuation replay with %s",
    async (scenario) => {
      // Break caught: the completed-run bypass lets stale A borrow B's live
      // reservation and move its cursor. Run/snapshot ownership alone agrees.
      const chain = await admittedContinuation();
      const queue = createDiscoveryQueue({
        connectionString: postgres.pool.options.connectionString!
      });
      await queue.start();
      try {
        const first = await postgres.pool.query<{ id: string }>(
          `SELECT id FROM fingerprint_sweep_admissions
         WHERE discovery_run_id = $1 AND status = 'admitted'`,
          [chain.run.id]
        );
        const payload = {
          ...continuation(chain.run.id),
          admissionId: first.rows[0]!.id
        };
        await queue.work((job, context) =>
          handler(
            chain.repositories,
            chain.upstream.gateway,
            chain.outcomes
          ).execute(job.runId, context, job)
        );
        const originalId = await queue.enqueue(payload);
        const completed = async (id: string) => {
          await expect
            .poll(
              async () => {
                const result = await postgres.pool.query(
                  "SELECT state FROM pgboss.job WHERE id = $1",
                  [id]
                );
                return result.rows[0]?.state;
              },
              { timeout: 5_000 }
            )
            .toBe("completed");
        };
        await completed(originalId);
        let replayPayload = payload;
        let replayOriginal = originalId;
        if (scenario === "next_cycle") {
          await expect(
            chain.repositories.fingerprintSweeps.admitWaiting(
              chain.run.id,
              new Date()
            )
          ).resolves.toEqual({ kind: "admitted" });
        } else {
          for (
            let cycle = 0;
            cycle < 8 &&
            (await chain.repositories.fingerprintSweeps.getResumeState(
              rootKey
            ));
            cycle++
          ) {
            await chain.repositories.fingerprintSweeps.admitWaiting(
              chain.run.id,
              new Date()
            );
            const descriptor =
              (await chain.repositories.fingerprintDeliveries!.descriptor(
                chain.run.id
              ))!;
            replayPayload = {
              ...continuation(chain.run.id),
              admissionId: descriptor.admissionId
            };
            replayOriginal = await queue.enqueue(replayPayload);
            await completed(replayOriginal);
          }
          await expect(
            chain.repositories.fingerprintSweeps.getResumeState(rootKey)
          ).resolves.toBeNull();
        }
        const beforeCursor =
          await chain.repositories.fingerprintSweeps.getResumeState(rootKey);
        const beforeReads = [...chain.upstream.state.reads];
        const beforeSnapshot =
          await chain.repositories.snapshots.getCurrent(rootKey);
        const beforeBudget = await postgres.pool.query(
          "SELECT count(*)::int AS requests FROM fingerprint_sweep_request_events"
        );
        // pg-boss deduplication ends at completion: this is a genuinely new job
        // carrying the old cycle's payload, not a repeated send of active work.
        const replayId = await queue.enqueue(replayPayload);
        expect(replayId).not.toBe(replayOriginal);
        await completed(replayId);
        expect(chain.upstream.state.reads).toEqual(beforeReads);
        await expect(
          chain.repositories.fingerprintSweeps.getResumeState(rootKey)
        ).resolves.toEqual(beforeCursor);
        await expect(
          chain.repositories.snapshots.getCurrent(rootKey)
        ).resolves.toEqual(beforeSnapshot);
        expect(
          (
            await postgres.pool.query(
              "SELECT count(*)::int AS requests FROM fingerprint_sweep_request_events"
            )
          ).rows
        ).toEqual(beforeBudget.rows);
        expect((await chain.repositories.runs.find(chain.run.id))?.status).toBe(
          "complete"
        );
      } finally {
        await queue.stop({ graceful: true, timeoutMs: 1_000 });
      }
    }
  );
});
