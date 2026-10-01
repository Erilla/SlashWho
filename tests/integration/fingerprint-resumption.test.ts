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
    options: { hold?: boolean; deferAtAttempt?: number } = {}
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
    const outcomes: string[] = [];
    let directHandler!: ReturnType<typeof createDiscoveryJobHandler>;
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
            directHandler = handler;
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
      execute: (...args: Parameters<typeof directHandler.execute>) =>
        directHandler.execute(...args),
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

  it("rejects an obsolete admission payload even with a higher durable attempt", async () => {
    // Design probe of the proposed offset: explicit durable contexts exercise
    // the real handler. Current queue metadata has no offset yet, so this is
    // deliberately not claimed as the full terminal queue replay regression.
    const fixture = await startRuntime();
    const reservationId = await reserveBudget();
    const run = await repositories.runs.createOrReuse(root, "anonymous");
    const originalId = await fixture.queue.enqueue({
      runId: run.id,
      key: root
    });
    await repositories.searchReservations.markEnqueued(run.id, originalId);
    await fixture.deferred.promise;
    await expectJobCompleted(originalId);
    await settle("admitted", reservationId);
    await expect(
      repositories.fingerprintSweeps.admitWaiting(run.id, new Date())
    ).resolves.toEqual({ kind: "admitted" });
    const admissionA = (
      await postgres.pool.query<{ id: string }>(
        `SELECT id FROM fingerprint_sweep_admissions
       WHERE discovery_run_id = $1 AND status = 'admitted'`,
        [run.id]
      )
    ).rows[0]!.id;
    const reservationA = (
      await postgres.pool.query<{ id: string }>(
        "SELECT id FROM fingerprint_sweep_reservations WHERE admission_id = $1",
        [admissionA]
      )
    ).rows[0]!.id;
    await repositories.fingerprintSweeps.release(reservationA, new Date());
    await reserveBudget();
    const payload = { runId: run.id, key: root, admissionId: admissionA };
    await fixture.execute(
      run.id,
      { attempt: 2, maxAttempts: 6, signal: new AbortController().signal },
      payload
    );
    const admissionB = (
      await postgres.pool.query<{ id: string }>(
        `SELECT id FROM fingerprint_sweep_admissions
       WHERE discovery_run_id = $1 AND status = 'waiting'`,
        [run.id]
      )
    ).rows[0]!.id;
    expect(admissionB).not.toBe(admissionA);
    const before = await repositories.runs.find(run.id);
    await fixture.execute(
      run.id,
      { attempt: 3, maxAttempts: 7, signal: new AbortController().signal },
      payload
    );
    expect((await repositories.runs.find(run.id))?.attempt).toBe(
      before!.attempt
    );
  });

  for (const kind of ["admitted", "not_due"] as const) {
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
});
