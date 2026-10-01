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

  it("rejects a terminal continuation replay after the next cycle is admitted", async () => {
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
      await expect(
        chain.repositories.fingerprintSweeps.admitWaiting(
          chain.run.id,
          new Date()
        )
      ).resolves.toEqual({ kind: "admitted" });
      const beforeCursor =
        await chain.repositories.fingerprintSweeps.getResumeState(rootKey);
      const beforeReads = [...chain.upstream.state.reads];
      const beforeBudget = await postgres.pool.query(
        "SELECT count(*)::int AS requests FROM fingerprint_sweep_request_events"
      );
      // pg-boss deduplication ends at completion: this is a genuinely new job
      // carrying the old cycle's payload, not a repeated send of active work.
      const replayId = await queue.enqueue(payload);
      expect(replayId).not.toBe(originalId);
      await completed(replayId);
      expect(chain.upstream.state.reads).toEqual(beforeReads);
      await expect(
        chain.repositories.fingerprintSweeps.getResumeState(rootKey)
      ).resolves.toEqual(beforeCursor);
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
  });
});
