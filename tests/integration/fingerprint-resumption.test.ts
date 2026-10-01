import type { CharacterKey } from "@slashwho/domain";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it
} from "vitest";

import { createDiscoveryJobHandler } from "../../packages/application/src";
import {
  createDiscoveryQueue,
  createPostgresRepositories,
  runMigrations,
  StaleFingerprintDeliveryError,
  type DiscoveryQueue,
  type Repositories
} from "../../packages/database/src";
import { loadWorkerConfig } from "../../apps/worker/src/config";
import { createWorkerRuntime } from "../../apps/worker/src/runtime";
import { startPostgres } from "./postgres";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const root: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "resumptionroot"
};
const blocker: CharacterKey = { ...root, name: "budgetblocker" };

describe("fingerprint resumption through the worker dispatcher", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let repositories: Repositories;
  const cleanup: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    postgres = await startPostgres();
    await runMigrations(postgres.pool);
  });
  beforeEach(async () => {
    await postgres.pool.query(`TRUNCATE fingerprint_sweep_request_events,
      fingerprint_sweep_reservations, fingerprint_sweep_admissions,
      fingerprint_sweep_states, snapshots, discovery_runs, characters CASCADE`);
    // pg-boss's schema is created by the first runtime, not by app migrations.
    if (
      (
        await postgres.pool.query(
          "SELECT to_regclass('pgboss.job') AS table_name"
        )
      ).rows[0].table_name
    ) {
      await postgres.pool.query("DELETE FROM pgboss.job");
    }
    repositories = createPostgresRepositories(postgres.pool);
  });
  afterEach(async () => {
    // Unblock deliveries before stopping their queue.
    for (const stop of cleanup.splice(0).reverse()) await stop();
  });
  afterAll(async () => {
    await postgres.stop();
  });

  async function startRuntime(
    options: {
      hold?: boolean;
      deferAtAttempt?: number;
      beforeResume?: () => Promise<void>;
      failResumedReads?: number;
    } = {}
  ) {
    const connectionString = postgres.pool.options.connectionString!;
    const queue = createDiscoveryQueue({ connectionString });
    let admissionWork!: (runId: string) => Promise<void>;
    const deferred = barrier();
    const unblock = barrier();
    cleanup.push(async () => {
      unblock.release();
    });
    let held = false;
    let inResume = false;
    let failures = options.failResumedReads ?? 0;
    const outcomes: string[] = [];
    const deliveries: number[] = [];
    const config = loadWorkerConfig({
      DATABASE_URL: connectionString,
      BLIZZARD_CLIENT_ID: "test",
      BLIZZARD_CLIENT_SECRET: "test",
      BLIZZARD_SWEEP_REQUEST_CAP: "5",
      WARCRAFT_LOGS_CLIENT_ID: "test",
      WARCRAFT_LOGS_CLIENT_SECRET: "test",
      EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64)
    });
    const start = async () =>
      createWorkerRuntime(
        config,
        {
          createPool: () => ({
            query: (sql, values) => postgres.pool.query(sql, values),
            // The container owns this pool across simulated process restarts.
            end: async () => {}
          }),
          runMigrations: async () => {},
          createRepositories: () => repositories,
          createQueue: () =>
            ({
              ...queue,
              // Exercise the real runtime's admission/dispatch closure on demand.
              // This avoids waiting for a budget retry timer and controls ordering.
              workFingerprintAdmissions: async (work) => {
                admissionWork = work;
              },
              scheduleEvidenceResume: async () => {},
              scheduleMaintenanceCleanup: async () => {},
              workCharacterEvidence: async () => {}
            }) satisfies DiscoveryQueue,
          createGateway: () => ({
            async getCharacter(key) {
              if (inResume && failures-- > 0)
                throw Object.assign(new Error("controlled_transient"), {
                  kind: "transient",
                  retryAfterMs: 1_000
                });
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
            },
            async getClaimedCharacters() {
              return { characters: [] };
            },
            async resolveProfileGuess() {
              return null;
            },
            async getMythicBossRankings() {
              throw new Error("unused_fixture_gateway");
            }
          }),
          createEvidenceGateway: () => ({
            async getFirstKillReports() {
              throw new Error("unused_fixture_gateway");
            },
            async getRateLimit() {
              return {
                limitPerHour: 3600,
                pointsSpentThisHour: 0,
                kind: "rate_limit" as const,
                pointsResetInSeconds: 3600
              };
            }
          }),
          createEvidenceHandler: () => ({ async execute() {} }),
          createFingerprintIntegration: () => ({
            fingerprint: {
              requestCap: 5,
              hourlyBudget: 5,
              cadenceMs: 7 * 24 * 60 * 60_000,
              minimumCommon: 200,
              minimumIdenticalPercent: 20
            },
            blizzardGateway: {
              async getGuildRoster() {
                return [];
              },
              async getGuildRosterByIdentity() {
                return [];
              },
              async getAchievementFingerprint() {
                return new Map();
              },
              async getCompletedAchievements() {
                return [];
              }
            }
          }),
          createHandler: (input) => {
            const handler = createDiscoveryJobHandler(input);
            return {
              async execute(runId, context, job) {
                deliveries.push(context!.attempt);
                if (!held && context!.attempt < (options.deferAtAttempt ?? 1)) {
                  // A controlled failed discovery delivery establishes durable
                  // claim history, then pg-boss supplies its real retry metadata.
                  await repositories.runs.claim(runId, context!.attempt);
                  await repositories.runs.markRetrying(
                    runId,
                    context!.attempt,
                    new Date()
                  );
                  throw new Error("controlled_delivery_failure");
                }
                if (job?.admissionId) await options.beforeResume?.();
                if (job?.admissionId) inResume = true;
                await handler.execute(runId, context, job);
                if (
                  !held &&
                  outcomes.at(-1) === "fingerprint_admission_waiting"
                ) {
                  held = true;
                  deferred.release();
                  if (options.hold) await unblock.promise;
                }
              }
            };
          },
          sleep: async () => {}
        },
        {
          info(record) {
            if (record.event === "discovery_run")
              outcomes.push(String(record.outcome));
          }
        }
      );
    const runtime = await start();
    cleanup.push(async () => {
      unblock.release();
      await runtime.stop();
    });
    return {
      queue,
      deferred,
      unblock,
      outcomes,
      deliveries,
      stop: () => runtime.stop(),
      admission: (runId: string) => admissionWork(runId)
    };
  }

  async function reserveBudget() {
    const run = await repositories.runs.createOrReuse(blocker, "anonymous");
    await repositories.runs.claim(run.id, 1);
    const admission = await repositories.fingerprintSweeps.requestAdmission({
      runId: run.id,
      key: blocker,
      requestCap: 5,
      hourlyBudget: 5,
      cadenceCutoff: new Date(0),
      at: new Date()
    });
    expect(admission.kind).toBe("admitted");
    if (admission.kind !== "admitted")
      throw new Error("fixture_budget_not_reserved");
    return admission.reservationId;
  }

  async function settle(kind: "admitted" | "not_due", reservationId: string) {
    await repositories.fingerprintSweeps.release(reservationId, new Date());
    if (kind === "not_due") {
      // Another run publishes a recent sweep while this run waits.
      await postgres.pool.query(
        `INSERT INTO fingerprint_sweep_states
        (region, realm_slug, normalized_name, last_published_at)
        VALUES ($1, $2, $3, now())`,
        [root.region, root.realm, root.name]
      );
    }
  }

  async function expectJobCompleted(jobId: string) {
    await expect
      .poll(
        async () => {
          const result = await postgres.pool.query(
            "SELECT state FROM pgboss.job WHERE id = $1",
            [jobId]
          );
          return result.rows[0]?.state;
        },
        { timeout: 5_000 }
      )
      .toBe("completed");
  }

  it.each(["waiting", "admitted"] as const)(
    "rejects terminal A after lost dispatch recording with B %s",
    async (nextKind) => {
      let resumeCount = 0;
      let reservationA = "";
      let blockerB = "";
      const fixture = await startRuntime({
        beforeResume: async () => {
          if (resumeCount++ === 0) {
            await repositories.fingerprintSweeps.release(
              reservationA,
              new Date()
            );
            blockerB = await reserveBudget();
          }
        }
      });
      const blockerId = await reserveBudget();
      const run = await repositories.runs.createOrReuse(root, "anonymous");
      const originalId = await fixture.queue.enqueue({
        runId: run.id,
        key: root
      });
      await repositories.searchReservations.markEnqueued(run.id, originalId);
      await fixture.deferred.promise;
      await expectJobCompleted(originalId);
      await settle("admitted", blockerId);
      await repositories.fingerprintSweeps.admitWaiting(run.id, new Date());
      const descriptor = (await repositories.fingerprintDeliveries!.descriptor(
        run.id
      ))!;
      reservationA = (
        await postgres.pool.query<{ id: string }>(
          "SELECT id FROM fingerprint_sweep_reservations WHERE admission_id = $1",
          [descriptor.admissionId]
        )
      ).rows[0]!.id;
      const mark = repositories.fingerprintDeliveries!.markDispatched;
      repositories.fingerprintDeliveries!.markDispatched = async () => {
        throw new Error("lost_dispatch_recording");
      };
      await expect(fixture.admission(run.id)).rejects.toThrow(
        "lost_dispatch_recording"
      );
      repositories.fingerprintDeliveries!.markDispatched = mark;
      const deliveryId = (
        await postgres.pool.query<{ id: string }>(
          "SELECT id FROM pgboss.job WHERE data->>'admissionId' = $1",
          [descriptor.admissionId]
        )
      ).rows[0]!.id;
      await expectJobCompleted(deliveryId);
      const before = await repositories.runs.find(run.id);
      expect(before?.status).toBe("queued");
      expect(before?.attempt).toBe(2);
      const next = (
        await postgres.pool.query<{ id: string; attempt_base: number }>(
          "SELECT id, attempt_base FROM fingerprint_sweep_admissions WHERE discovery_run_id = $1 AND status = 'waiting'",
          [run.id]
        )
      ).rows[0]!;
      expect(next.id).not.toBe(descriptor.admissionId);
      expect(next.attempt_base).toBe(2);
      expect(
        await repositories.fingerprintSweeps.listAdmittedUndispatched(100)
      ).not.toContain(run.id);
      if (nextKind === "admitted") {
        await settle("admitted", blockerB);
        await repositories.fingerprintSweeps.admitWaiting(run.id, new Date());
      }
      const nextBefore = (
        await postgres.pool.query(
          `SELECT a.status, a.attempt_base, a.execution_job_id,
      a.consumed_at, r.used_count, r.released_at FROM fingerprint_sweep_admissions a
      LEFT JOIN fingerprint_sweep_reservations r ON r.admission_id = a.id WHERE a.id = $1`,
          [next.id]
        )
      ).rows[0];
      expect(nextBefore.status).toBe(nextKind);
      const outcomes = [...fixture.outcomes];
      // Even a stale recovery sender with a newly computed baseline cannot
      // rebind a terminal delivery or claim work belonging to B.
      const replayId = await fixture.queue.enqueue({
        runId: run.id,
        key: root,
        admissionId: descriptor.admissionId,
        attemptBase: 100
      });
      expect(replayId).not.toBe(deliveryId);
      await expectJobCompleted(replayId);
      expect((await repositories.runs.find(run.id))?.attempt).toBe(2);
      expect(fixture.outcomes).toEqual(outcomes);
      expect(
        (
          await postgres.pool.query(
            `SELECT a.status, a.attempt_base, a.execution_job_id,
      a.consumed_at, r.used_count, r.released_at FROM fingerprint_sweep_admissions a
      LEFT JOIN fingerprint_sweep_reservations r ON r.admission_id = a.id WHERE a.id = $1`,
            [next.id]
          )
        ).rows[0]
      ).toEqual(nextBefore);

      expect(
        (
          await postgres.pool.query(
            "SELECT attempt_base, execution_attempt, execution_job_id FROM fingerprint_sweep_admissions WHERE id = $1",
            [descriptor.admissionId]
          )
        ).rows[0]
      ).toEqual({
        attempt_base: 1,
        execution_attempt: 1,
        execution_job_id: deliveryId
      });
    }
  );
  it("keeps a resumed job's retry allowance separate from its durable claim baseline", async () => {
    const fixture = await startRuntime({ failResumedReads: 1 });
    const reservationId = await reserveBudget();
    const run = await repositories.runs.createOrReuse(root, "anonymous");
    const originalId = await fixture.queue.enqueue({
      runId: run.id,
      key: root
    });
    await fixture.deferred.promise;
    await expectJobCompleted(originalId);
    await settle("admitted", reservationId);
    await fixture.admission(run.id);
    await expect
      .poll(async () => (await repositories.runs.find(run.id))?.status, {
        timeout: 10_000
      })
      .toBe("complete");
    expect((await repositories.runs.find(run.id))?.attempt).toBe(3);
    expect(fixture.outcomes).toEqual([
      "fingerprint_admission_waiting",
      "retrying",
      "snapshot"
    ]);
    expect(
      (
        await postgres.pool.query(
          `SELECT attempt_base, execution_attempt, execution_max_attempts
      FROM fingerprint_sweep_admissions WHERE discovery_run_id = $1`,
          [run.id]
        )
      ).rows[0]
    ).toEqual({
      attempt_base: 1,
      execution_attempt: 2,
      execution_max_attempts: 5
    });
  });

  it("fences run, budget and snapshot writes from an execution superseded by a retry", async () => {
    const first = await startRuntime();
    const blockerId = await reserveBudget();
    const run = await repositories.runs.createOrReuse(root, "anonymous");
    const originalId = await first.queue.enqueue({ runId: run.id, key: root });
    await first.deferred.promise;
    await expectJobCompleted(originalId);
    await first.stop();
    await settle("admitted", blockerId);
    await repositories.fingerprintSweeps.admitWaiting(run.id, new Date());
    const descriptor = (await repositories.fingerprintDeliveries!.descriptor(
      run.id
    ))!;
    const sender = createDiscoveryQueue({
      connectionString: postgres.pool.options.connectionString!
    });
    await sender.start();
    cleanup.push(() => sender.stop({ graceful: false, timeoutMs: 1_000 }));
    const jobId = await sender.enqueue({
      runId: run.id,
      key: root,
      admissionId: descriptor.admissionId
    });
    const reservationId = (
      await postgres.pool.query<{ id: string }>(
        "SELECT id FROM fingerprint_sweep_reservations WHERE admission_id = $1",
        [descriptor.admissionId]
      )
    ).rows[0]!.id;
    const entered = barrier();
    const proceed = barrier();
    cleanup.push(async () => {
      proceed.release();
    });
    const delivery = repositories.fingerprintDeliveries!;
    const input = {
      runId: run.id,
      admissionId: descriptor.admissionId,
      jobId,
      attempt: 1,
      maxAttempts: 5
    };
    const firstExecution = delivery.execute(input, async (execution) => {
      entered.release();
      await proceed.promise;
      await expect(
        execution.repositories.runs.markRetrying(run.id, 2, new Date())
      ).rejects.toBeInstanceOf(StaleFingerprintDeliveryError);
      await expect(
        execution.repositories.fingerprintSweeps.recordRequest(
          reservationId,
          1,
          new Date()
        )
      ).rejects.toBeInstanceOf(StaleFingerprintDeliveryError);
      await expect(
        execution.repositories.fingerprintSweeps.release(
          reservationId,
          new Date()
        )
      ).rejects.toBeInstanceOf(StaleFingerprintDeliveryError);
      await expect(
        execution.repositories.snapshots.create({
          runId: run.id,
          rootKey: root,
          state: "complete",
          limitationCode: null,
          refreshedAt: new Date(),
          characters: []
        })
      ).rejects.toBeInstanceOf(StaleFingerprintDeliveryError);
      await expect(
        execution.repositories.fingerprintSweeps.requeueContinuation(run.id, {
          at: new Date(),
          notBefore: new Date()
        })
      ).rejects.toBeInstanceOf(StaleFingerprintDeliveryError);
    });
    await entered.promise;
    await delivery.execute({ ...input, attempt: 2 }, async () => {});
    proceed.release();
    await firstExecution;
    expect((await repositories.runs.find(run.id))?.attempt).toBe(3);
    expect(
      (
        await postgres.pool.query(
          "SELECT count(*)::int AS count FROM snapshots"
        )
      ).rows[0]?.count
    ).toBe(0);
    expect(
      (
        await postgres.pool.query(
          "SELECT count(*)::int AS count FROM fingerprint_sweep_request_events"
        )
      ).rows[0]?.count
    ).toBe(0);
  });

  for (const kind of ["admitted", "not_due"] as const) {
    for (const loseRecording of [false, true]) {
      it(`recovers ${kind} on restart ${loseRecording ? "after enqueue without recording" : "before enqueue"}`, async () => {
        const first = await startRuntime();
        const reservationId = await reserveBudget();
        const run = await repositories.runs.createOrReuse(root, "anonymous");
        const jobId = await first.queue.enqueue({ runId: run.id, key: root });
        await repositories.searchReservations.markEnqueued(run.id, jobId);
        await first.deferred.promise;
        await expectJobCompleted(jobId);
        await settle(kind, reservationId);
        await repositories.fingerprintSweeps.admitWaiting(run.id, new Date());
        await first.stop();
        if (loseRecording) {
          const mark = repositories.fingerprintDeliveries!.markDispatched;
          repositories.fingerprintDeliveries!.markDispatched = async () => {
            throw new Error("startup_crash_after_enqueue");
          };
          await expect(startRuntime()).rejects.toThrow(
            "startup_crash_after_enqueue"
          );
          repositories.fingerprintDeliveries!.markDispatched = mark;
        }
        await startRuntime();
        await expect
          .poll(async () => (await repositories.runs.find(run.id))?.status, {
            timeout: 5_000
          })
          .toBe("complete");
        const jobs = await postgres.pool.query(
          `SELECT id FROM pgboss.job
          WHERE name = 'discover-character' AND data->>'runId' = $1`,
          [run.id]
        );
        expect(jobs.rows).toHaveLength(2);
      });
    }

    it(`upgrades an old attempt-2 ${kind} admission once and cancels its legacy delivery`, async () => {
      const first = await startRuntime({ deferAtAttempt: 2 });
      const reservationId = await reserveBudget();
      const run = await repositories.runs.createOrReuse(root, "anonymous");
      const jobId = await first.queue.enqueue({ runId: run.id, key: root });
      await repositories.searchReservations.markEnqueued(run.id, jobId);
      await first.deferred.promise;
      await expectJobCompleted(jobId);
      await first.stop();
      await settle(kind, reservationId);
      await repositories.fingerprintSweeps.admitWaiting(run.id, new Date());
      // Old code decremented the durable attempt and could die with an active
      // delivery and running run. Workers are stopped before upgrade.
      await postgres.pool.query(
        "UPDATE discovery_runs SET attempt = 1, status = 'running' WHERE id = $1",
        [run.id]
      );
      await postgres.pool.query(
        "UPDATE pgboss.job SET state = 'active' WHERE id = $1",
        [jobId]
      );
      await postgres.pool.query(
        `UPDATE fingerprint_sweep_admissions SET attempt_base = NULL,
        dispatch_kind = NULL, execution_max_attempts = NULL WHERE discovery_run_id = $1`,
        [run.id]
      );
      const next = await startRuntime();
      await expect
        .poll(async () => (await repositories.runs.find(run.id))?.status, {
          timeout: 5_000
        })
        .toBe("complete");
      expect((await repositories.runs.find(run.id))?.attempt).toBe(3);
      expect(
        (
          await postgres.pool.query(
            "SELECT state FROM pgboss.job WHERE id = $1",
            [jobId]
          )
        ).rows[0]?.state
      ).toBe("cancelled");
      const metadata = (
        await postgres.pool.query(
          `SELECT attempt_base, execution_job_id
        FROM fingerprint_sweep_admissions WHERE discovery_run_id = $1`,
          [run.id]
        )
      ).rows;
      expect(metadata[0]?.attempt_base).toBe(2);
      await repositories.fingerprintDeliveries!.recoverLegacy();
      expect(
        (
          await postgres.pool.query(
            `SELECT attempt_base, execution_job_id
        FROM fingerprint_sweep_admissions WHERE discovery_run_id = $1`,
            [run.id]
          )
        ).rows
      ).toEqual(metadata);
      await next.stop();
    });

    it(`runs one effective successor when ${kind} dispatch happens during the original active delivery`, async () => {
      // Break caught: enqueue returns the predecessor's ID and dispatch is
      // acknowledged, so the queued run never receives resumed discovery.
      const fixture = await startRuntime({ hold: true });
      const reservationId = await reserveBudget();
      const run = await repositories.runs.createOrReuse(root, "anonymous");
      const originalId = await fixture.queue.enqueue({
        runId: run.id,
        key: root
      });
      await repositories.searchReservations.markEnqueued(run.id, originalId);
      await fixture.deferred.promise;
      expect((await repositories.runs.find(run.id))?.status).toBe("queued");
      await settle(kind, reservationId);
      await fixture.admission(run.id);
      // Both dispatcher invocations must refer to the same successor.
      await fixture.admission(run.id);
      fixture.unblock.release();
      await expectJobCompleted(originalId);
      await expect
        .poll(async () => (await repositories.runs.find(run.id))?.status, {
          timeout: 2_000
        })
        .toBe("complete");
      expect(
        fixture.outcomes.filter((outcome) => outcome === "snapshot")
      ).toHaveLength(1);
      const jobs = await postgres.pool.query(
        `SELECT id FROM pgboss.job
        WHERE name = 'discover-character' AND data->>'runId' = $1`,
        [run.id]
      );
      expect(jobs.rows).toHaveLength(2);
    });

    for (const attempt of [2, 3]) {
      it(`claims a fresh ${kind} delivery after deferral at attempt ${attempt}`, async () => {
        // Break caught: the fresh job supplies attempt 1 and cannot claim a
        // run whose durable attempt remains >= 1 after deferral.
        const fixture = await startRuntime({ deferAtAttempt: attempt });
        const reservationId = await reserveBudget();
        const run = await repositories.runs.createOrReuse(root, "anonymous");
        const originalId = await fixture.queue.enqueue({
          runId: run.id,
          key: root
        });
        await repositories.searchReservations.markEnqueued(run.id, originalId);
        await fixture.deferred.promise;
        await expectJobCompleted(originalId);
        await settle(kind, reservationId);
        await fixture.admission(run.id);
        await expect
          .poll(
            async () => {
              const jobs = await postgres.pool.query(
                `SELECT state FROM pgboss.job
            WHERE name = 'discover-character' AND data->>'runId' = $1 AND id <> $2`,
                [run.id, originalId]
              );
              return jobs.rows[0]?.state;
            },
            { timeout: 5_000 }
          )
          .toBe("completed");
        expect((await repositories.runs.find(run.id))?.status).toBe("complete");
        expect(fixture.outcomes.at(-1)).toBe("snapshot");
      });
    }
  }

  it("retires an exhausted crashed delivery without restarting its retry allowance", async () => {
    const first = await startRuntime();
    const blockerId = await reserveBudget();
    const run = await repositories.runs.createOrReuse(root, "anonymous");
    const originalId = await first.queue.enqueue({ runId: run.id, key: root });
    await first.deferred.promise;
    await expectJobCompleted(originalId);
    await first.stop();
    await settle("admitted", blockerId);
    await repositories.fingerprintSweeps.admitWaiting(run.id, new Date());
    const descriptor = (await repositories.fingerprintDeliveries!.descriptor(
      run.id
    ))!;
    const queue = createDiscoveryQueue({
      connectionString: postgres.pool.options.connectionString!
    });
    await queue.start();
    cleanup.push(() => queue.stop({ graceful: false, timeoutMs: 1_000 }));
    const payload = {
      runId: run.id,
      key: root,
      admissionId: descriptor.admissionId
    };
    const jobId = await queue.enqueue(payload);
    await postgres.pool.query(
      "UPDATE pgboss.job SET retry_count = 4 WHERE id = $1",
      [jobId]
    );
    await queue.work(async (job, context) => {
      await repositories.fingerprintDeliveries!.execute(
        {
          runId: run.id,
          admissionId: job.admissionId!,
          jobId: context.jobId!,
          attempt: context.attempt,
          maxAttempts: context.maxAttempts
        },
        async () => {
          throw new Error("crashed_after_claim");
        }
      );
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
      .toBe("failed");
    expect((await repositories.runs.find(run.id))?.status).toBe("running");
    await repositories.fingerprintDeliveries!.recoverTerminal();
    expect((await repositories.runs.find(run.id))?.status).toBe("failed");
    const before = (
      await postgres.pool.query(
        `SELECT attempt_base, execution_attempt, execution_job_id, consumed_at
      FROM fingerprint_sweep_admissions WHERE id = $1`,
        [descriptor.admissionId]
      )
    ).rows;
    expect(before[0]?.execution_attempt).toBe(5);
    expect(before[0]?.consumed_at).not.toBeNull();
    expect(
      (
        await postgres.pool.query(
          "SELECT released_at FROM fingerprint_sweep_reservations WHERE admission_id = $1",
          [descriptor.admissionId]
        )
      ).rows[0]?.released_at
    ).not.toBeNull();
    await repositories.fingerprintDeliveries!.recoverTerminal();
    const replayId = await queue.enqueue(payload);
    await expectJobCompleted(replayId);
    expect(
      (
        await postgres.pool.query(
          `SELECT attempt_base, execution_attempt, execution_job_id, consumed_at
      FROM fingerprint_sweep_admissions WHERE id = $1`,
          [descriptor.admissionId]
        )
      ).rows
    ).toEqual(before);
  });
});
