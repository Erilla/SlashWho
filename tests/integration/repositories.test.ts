import type { CharacterKey } from "@slashwho/domain";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresRepositories,
  runMigrations,
  type Repositories,
  type SnapshotCharacterInput,
  type StoredSnapshot
} from "../../packages/database/src";
import { startPostgres } from "./postgres";

const rootKey = {
  region: "eu",
  realm: "silvermoon",
  name: "ryii"
} as const;

const altKey = {
  region: "us",
  realm: "area-52",
  name: "other"
} as const;

function observation(
  key: CharacterKey,
  displayName: string,
  source: SnapshotCharacterInput["source"] = "input"
): SnapshotCharacterInput {
  return {
    key,
    displayName,
    className: "Mage",
    level: 80,
    raiderIoUrl: `https://raider.io/characters/${key.region}/${key.realm}/${key.name}`,
    source
  };
}

async function seedCompleteSnapshot(
  repositories: Repositories,
  options: {
    refreshedAt?: Date;
    displayName?: string;
    characters?: SnapshotCharacterInput[];
    state?: "complete" | "partial";
    limitationCode?: string | null;
  } = {}
): Promise<StoredSnapshot> {
  const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
  await repositories.runs.markRunning(run.id);
  const snapshot = await repositories.snapshots.create({
    runId: run.id,
    rootKey,
    state: options.state ?? "complete",
    limitationCode: options.limitationCode ?? null,
    refreshedAt: options.refreshedAt ?? new Date(),
    characters: options.characters ?? [
      observation(rootKey, options.displayName ?? "Ryii")
    ]
  });
  await repositories.runs.complete(run.id, snapshot.id);
  return snapshot;
}

describe("PostgreSQL repositories", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let repositories: Repositories;

  beforeAll(async () => {
    ({ pool, stop } = await startPostgres());
    await runMigrations(pool);
    repositories = createPostgresRepositories(pool);
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE
      snapshot_characters,
      snapshots,
      discovery_runs,
      characters,
      suppressed_characters,
      negative_character_cache,
      rate_limit_events
      CASCADE`);
  });

  afterAll(async () => {
    await stop();
  });

  it("reuses one active run under concurrent requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        repositories.runs.createOrReuse(rootKey, "anonymous")
      )
    );

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
  });

  it("atomically grants one claim for a delivery attempt", async () => {
    // Break caught: duplicate deliveries could both perform discovery and persistence.
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");

    const claims = await Promise.all([
      repositories.runs.claim(run.id, 1),
      repositories.runs.claim(run.id, 1)
    ]);

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "running",
      attempt: 1
    });
  });

  it("records retry and failure lifecycle fields without leaking diagnostics", async () => {
    const run = await repositories.runs.createOrReuse(rootKey, "bot");
    const retryAt = new Date("2026-08-04T12:05:00.000Z");
    await repositories.runs.markRunning(run.id);
    await repositories.runs.markRetrying(run.id, 3, retryAt);
    expect(await repositories.runs.find(run.id)).toMatchObject({
      status: "retrying",
      attempt: 3,
      nextRetryAt: retryAt
    });

    await repositories.runs.fail(run.id, "upstream_unavailable");

    expect(await repositories.runs.find(run.id)).toMatchObject({
      status: "failed",
      callerClass: "bot",
      attempt: 3,
      nextRetryAt: null,
      errorCode: "upstream_unavailable"
    });
    expect(await repositories.runs.findActive(rootKey)).toBeNull();
  });

  it("clears a scheduled retry when the run starts again", async () => {
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await repositories.runs.markRetrying(
      run.id,
      2,
      new Date("2026-08-04T12:05:00.000Z")
    );

    await repositories.runs.markRunning(run.id);

    expect(await repositories.runs.find(run.id)).toMatchObject({
      status: "running",
      nextRetryAt: null
    });
  });

  it("stores a snapshot and every membership row atomically", async () => {
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const duplicate = observation(rootKey, "Ryii");

    await expect(
      repositories.snapshots.create({
        runId: run.id,
        rootKey,
        state: "complete",
        limitationCode: null,
        refreshedAt: new Date("2026-08-04T12:00:00.000Z"),
        characters: [duplicate, duplicate]
      })
    ).rejects.toMatchObject({ code: "23505" });

    const counts = await pool.query<{ characters: string; snapshots: string }>(`
      SELECT
        (SELECT count(*)::text FROM characters) AS characters,
        (SELECT count(*)::text FROM snapshots) AS snapshots
    `);
    expect(counts.rows[0]).toEqual({ characters: "0", snapshots: "0" });
  });

  it("rolls back fingerprint cadence completion when merged snapshot publication cannot finish", async () => {
    // Break caught: a crash between snapshot completion and cadence advancement
    // could make the public snapshot visible while the sweep stayed reusable.
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await repositories.runs.markRunning(run.id);
    const admission = await repositories.fingerprintSweeps.requestAdmission({
      runId: run.id,
      key: rootKey,
      requestCap: 1,
      hourlyBudget: 2,
      cadenceCutoff: new Date("2026-08-01T12:00:00.000Z"),
      at: new Date("2026-08-08T12:00:00.000Z")
    });
    if (admission.kind !== "admitted") throw new Error("sweep_not_admitted");

    await expect(
      repositories.snapshots.createAndFinishFingerprintSweep(
        {
          runId: run.id,
          rootKey,
          state: "complete",
          limitationCode: null,
          refreshedAt: new Date("2026-08-08T12:00:00.000Z"),
          characters: [observation(rootKey, "Ryii")]
        },
        {
          reservationId: "00000000-0000-4000-8000-000000000999",
          finishedAt: new Date("2026-08-08T12:00:00.000Z"),
          limitationCode: null
        }
      )
    ).rejects.toThrow("fingerprint_reservation_not_active");

    await expect(
      repositories.snapshots.getCurrent(rootKey)
    ).resolves.toBeNull();
    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "running",
      snapshotId: null
    });
  });

  it("publishes the snapshot and advances fingerprint cadence together", async () => {
    // Break caught: a successful combined publication could commit the snapshot
    // but leave the next run eligible for another sweep immediately.
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await repositories.runs.markRunning(run.id);
    const at = new Date("2026-08-08T12:00:00.000Z");
    const admission = await repositories.fingerprintSweeps.requestAdmission({
      runId: run.id,
      key: rootKey,
      requestCap: 1,
      hourlyBudget: 2,
      cadenceCutoff: new Date("2026-08-01T12:00:00.000Z"),
      at
    });
    if (admission.kind !== "admitted") throw new Error("sweep_not_admitted");

    await repositories.snapshots.createAndFinishFingerprintSweep(
      {
        runId: run.id,
        rootKey,
        state: "complete",
        limitationCode: null,
        refreshedAt: at,
        characters: [observation(rootKey, "Ryii")]
      },
      {
        reservationId: admission.reservationId,
        finishedAt: at,
        limitationCode: null
      }
    );

    const nextRun = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await expect(
      repositories.fingerprintSweeps.requestAdmission({
        runId: nextRun.id,
        key: rootKey,
        requestCap: 1,
        hourlyBudget: 2,
        cadenceCutoff: new Date("2026-08-01T12:00:00.000Z"),
        at: new Date("2026-08-08T12:01:00.000Z")
      })
    ).resolves.toEqual({ kind: "not_due" });
  });

  it("avoids deadlocks for overlapping snapshots with inverse display order", async () => {
    const firstRun = await repositories.runs.createOrReuse(
      rootKey,
      "anonymous"
    );
    const secondRun = await repositories.runs.createOrReuse(
      altKey,
      "anonymous"
    );
    await pool.query(`
      CREATE FUNCTION test_pause_character_write() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(0.2);
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER test_pause_character_write
      AFTER INSERT OR UPDATE ON characters
      FOR EACH ROW EXECUTE FUNCTION test_pause_character_write();
    `);

    let results: PromiseSettledResult<StoredSnapshot>[];
    try {
      results = await Promise.allSettled([
        repositories.snapshots.create({
          runId: firstRun.id,
          rootKey,
          state: "complete",
          limitationCode: null,
          refreshedAt: new Date("2026-08-04T12:00:00.000Z"),
          characters: [
            observation(rootKey, "Ryii"),
            observation(altKey, "Other", "claimed")
          ]
        }),
        repositories.snapshots.create({
          runId: secondRun.id,
          rootKey: altKey,
          state: "complete",
          limitationCode: null,
          refreshedAt: new Date("2026-08-04T12:00:00.000Z"),
          characters: [
            observation(altKey, "Other"),
            observation(rootKey, "Ryii", "claimed")
          ]
        })
      ]);
    } finally {
      await pool.query("DROP TRIGGER test_pause_character_write ON characters");
      await pool.query("DROP FUNCTION test_pause_character_write() CASCADE");
    }

    expect(results.every(({ status }) => status === "fulfilled")).toBe(true);
    if (results[0]?.status === "fulfilled") {
      expect(results[0].value.characters.map(({ key }) => key)).toEqual([
        rootKey,
        altKey
      ]);
    }
    if (results[1]?.status === "fulfilled") {
      expect(results[1].value.characters.map(({ key }) => key)).toEqual([
        altKey,
        rootKey
      ]);
    }
  });

  it("rejects a snapshot whose root does not match its discovery run", async () => {
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");

    await expect(
      repositories.snapshots.create({
        runId: run.id,
        rootKey: altKey,
        state: "complete",
        limitationCode: null,
        refreshedAt: new Date("2026-08-04T12:00:00.000Z"),
        characters: [observation(altKey, "Other")]
      })
    ).rejects.toThrow("discovery_run_root_mismatch");

    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM snapshots"
    );
    expect(result.rows[0]?.count).toBe("0");
  });

  it("rejects completing a run with another run's snapshot", async () => {
    const firstRun = await repositories.runs.createOrReuse(
      rootKey,
      "anonymous"
    );
    const secondRun = await repositories.runs.createOrReuse(
      altKey,
      "anonymous"
    );
    const secondSnapshot = await repositories.snapshots.create({
      runId: secondRun.id,
      rootKey: altKey,
      state: "complete",
      limitationCode: null,
      refreshedAt: new Date("2026-08-04T12:00:00.000Z"),
      characters: [observation(altKey, "Other")]
    });

    await expect(
      repositories.runs.complete(firstRun.id, secondSnapshot.id)
    ).rejects.toThrow("discovery_run_not_found");
    expect((await repositories.runs.find(firstRun.id))?.status).toBe("queued");
  });

  it("keeps historical observations immutable when latest values change", async () => {
    const oldSnapshot = await seedCompleteSnapshot(repositories, {
      refreshedAt: new Date("2026-08-03T12:00:00.000Z"),
      displayName: "OldCasing"
    });
    const newSnapshot = await seedCompleteSnapshot(repositories, {
      refreshedAt: new Date("2026-08-04T12:00:00.000Z"),
      displayName: "NewCasing"
    });

    expect(
      (await repositories.snapshots.find(oldSnapshot.id))?.characters[0]
    ).toMatchObject({ displayName: "OldCasing" });
    expect((await repositories.snapshots.getCurrent(rootKey))?.id).toBe(
      newSnapshot.id
    );
    expect(
      (await repositories.snapshots.getCurrent(rootKey))?.characters[0]
    ).toMatchObject({ displayName: "NewCasing" });
  });

  it("does not replace the latest snapshot when a refresh fails", async () => {
    const previous = await seedCompleteSnapshot(repositories);
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await repositories.runs.fail(run.id, "upstream_unavailable");

    expect((await repositories.snapshots.getCurrent(rootKey))?.id).toBe(
      previous.id
    );
  });

  it("allows either snapshot publication or failure to win, never both", async () => {
    const previous = await seedCompleteSnapshot(repositories);
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await repositories.runs.markRunning(run.id);

    const [publication, failure] = await Promise.allSettled([
      repositories.snapshots.create({
        runId: run.id,
        rootKey,
        state: "complete",
        limitationCode: null,
        refreshedAt: new Date(previous.refreshedAt.getTime() + 1_000),
        characters: [observation(rootKey, "RefreshedRyii")]
      }),
      repositories.runs.fail(run.id, "upstream_unavailable")
    ]);

    expect([publication.status, failure.status].sort()).toEqual([
      "fulfilled",
      "rejected"
    ]);
    const finalRun = await repositories.runs.find(run.id);
    if (publication.status === "fulfilled") {
      expect(finalRun).toMatchObject({
        status: "complete",
        snapshotId: publication.value.id
      });
      expect((await repositories.snapshots.getCurrent(rootKey))?.id).toBe(
        publication.value.id
      );
    } else {
      expect(finalRun?.status).toBe("failed");
      expect((await repositories.snapshots.getCurrent(rootKey))?.id).toBe(
        previous.id
      );
    }
  });

  it("filters actively suppressed characters from snapshot results", async () => {
    const snapshot = await seedCompleteSnapshot(repositories, {
      characters: [
        observation(rootKey, "Ryii"),
        observation(altKey, "Other", "claimed")
      ]
    });
    await repositories.suppressions.suppress(
      altKey,
      "verified_removal_request",
      null
    );

    expect(
      (await repositories.snapshots.find(snapshot.id))?.characters
    ).toEqual([expect.objectContaining({ key: rootKey })]);
    expect(await repositories.suppressions.isActive(altKey)).toBe(true);
  });

  it("hides an entire snapshot when its root is actively suppressed", async () => {
    await seedCompleteSnapshot(repositories);
    await repositories.suppressions.suppress(
      rootKey,
      "verified_removal_request",
      null
    );

    expect(await repositories.snapshots.getCurrent(rootKey)).toBeNull();
  });

  it("paginates snapshot history with a stable cursor", async () => {
    const oldest = await seedCompleteSnapshot(repositories, {
      refreshedAt: new Date("2026-08-01T12:00:00.000Z")
    });
    const middle = await seedCompleteSnapshot(repositories, {
      refreshedAt: new Date("2026-08-02T12:00:00.000Z")
    });
    const newest = await seedCompleteSnapshot(repositories, {
      refreshedAt: new Date("2026-08-03T12:00:00.000Z")
    });

    const first = await repositories.snapshots.listHistory(rootKey, {
      cursor: null,
      limit: 2
    });
    expect(first.items.map(({ id }) => id)).toEqual([newest.id, middle.id]);
    expect(first.nextCursor).not.toBeNull();

    const second = await repositories.snapshots.listHistory(rootKey, {
      cursor: first.nextCursor,
      limit: 2
    });
    expect(second.items.map(({ id }) => id)).toEqual([oldest.id]);
    expect(second.nextCursor).toBeNull();
  });

  it("does not skip or duplicate equal-timestamp history rows", async () => {
    // Break caught: timestamp-only cursors could lose snapshots created in the same instant.
    const refreshedAt = new Date("2026-08-04T12:00:00.000Z");
    const snapshots = [
      await seedCompleteSnapshot(repositories, { refreshedAt }),
      await seedCompleteSnapshot(repositories, { refreshedAt }),
      await seedCompleteSnapshot(repositories, { refreshedAt })
    ];

    const observed: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await repositories.snapshots.listHistory(rootKey, {
        cursor,
        limit: 1
      });
      observed.push(...page.items.map(({ id }) => id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(new Set(observed)).toEqual(new Set(snapshots.map(({ id }) => id)));
    expect(observed).toHaveLength(3);
  });

  it("rejects malformed cursor UUIDs before querying PostgreSQL", async () => {
    const malformedCursor = Buffer.from(
      JSON.stringify({
        refreshedAt: "2026-08-04T12:00:00.000Z",
        id: `00000000${"-".repeat(28)}`
      })
    ).toString("base64url");

    await expect(
      repositories.snapshots.listHistory(rootKey, {
        cursor: malformedCursor,
        limit: 10
      })
    ).rejects.toThrow("invalid_cursor");
  });

  it("expires confirmed-missing character cache entries", async () => {
    const expiresAt = new Date("2026-08-04T13:00:00.000Z");
    await repositories.negativeCache.put(rootKey, expiresAt);

    expect(
      await repositories.negativeCache.find(
        rootKey,
        new Date("2026-08-04T12:59:59.000Z")
      )
    ).toEqual({ key: rootKey, expiresAt });
    expect(
      await repositories.negativeCache.find(
        rootKey,
        new Date("2026-08-04T13:00:00.000Z")
      )
    ).toBeNull();
  });

  it("deletes expired rate-limit events while retaining active events", async () => {
    const now = new Date("2026-08-04T13:00:00.000Z");
    await repositories.rateLimits.record(
      "sha256:expired",
      new Date("2026-08-04T12:59:59.000Z")
    );
    await repositories.rateLimits.record(
      "sha256:active",
      new Date("2026-08-04T13:00:01.000Z")
    );

    expect(await repositories.rateLimits.cleanupExpired(now)).toBe(1);
    expect(
      await repositories.rateLimits.countActive("sha256:expired", now)
    ).toBe(0);
    expect(
      await repositories.rateLimits.countActive("sha256:active", now)
    ).toBe(1);
  });

  it("admits only the FIFO head when two caps would exceed the rolling budget", async () => {
    // Break caught: later sweeps could jump the queue or oversubscribe the global hourly budget.
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states
      CASCADE`);
    const at = new Date("2026-08-10T12:00:00.000Z");
    const firstKey = rootKey;
    const secondKey = altKey;
    const firstRun = await repositories.runs.createOrReuse(
      firstKey,
      "anonymous"
    );
    const secondRun = await repositories.runs.createOrReuse(
      secondKey,
      "anonymous"
    );
    const first = {
      runId: firstRun.id,
      key: firstKey,
      requestCap: 3,
      hourlyBudget: 5,
      cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
      at
    };
    const second = { ...first, runId: secondRun.id, key: secondKey };

    const admitted =
      await repositories.fingerprintSweeps.requestAdmission(first);
    expect(admitted).toMatchObject({ kind: "admitted", requestCap: 3 });
    if (admitted.kind !== "admitted")
      throw new Error("first_sweep_not_admitted");

    await expect(
      repositories.fingerprintSweeps.requestAdmission(second)
    ).resolves.toMatchObject({ kind: "waiting" });
    await expect(
      repositories.fingerprintSweeps.listWaiting(10)
    ).resolves.toEqual([secondRun.id]);

    await repositories.fingerprintSweeps.finish(admitted.reservationId, {
      published: true,
      at,
      limitationCode: null
    });

    await expect(
      repositories.fingerprintSweeps.requestAdmission(second)
    ).resolves.toMatchObject({ kind: "admitted", requestCap: 3 });
  });

  it("atomically returns a budget-waiting discovery run to its unconsumed delivery", async () => {
    // Break caught: a crash after persisting private admission could leave the
    // run running, or its redispatch could start past the original retry count.
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states
      CASCADE`);
    const at = new Date("2026-08-10T12:00:00.000Z");
    const blockerRun = await repositories.runs.createOrReuse(
      rootKey,
      "anonymous"
    );
    const waitingRun = await repositories.runs.createOrReuse(
      altKey,
      "anonymous"
    );
    await repositories.runs.claim(waitingRun.id, 1);
    const blocker = await repositories.fingerprintSweeps.requestAdmission({
      runId: blockerRun.id,
      key: rootKey,
      requestCap: 3,
      hourlyBudget: 3,
      cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
      at
    });
    expect(blocker.kind).toBe("admitted");

    await expect(
      repositories.fingerprintSweeps.requestAdmission({
        runId: waitingRun.id,
        key: altKey,
        requestCap: 1,
        hourlyBudget: 3,
        cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
        at
      })
    ).resolves.toMatchObject({ kind: "waiting" });

    await expect(repositories.runs.find(waitingRun.id)).resolves.toMatchObject({
      status: "queued",
      attempt: 0
    });
  });

  it("admits a durable waiting run through private admission dispatch after budget frees", async () => {
    // Break caught: waiting sweeps could need another discovery delivery instead of being admitted privately.
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states
      CASCADE`);
    const at = new Date("2026-08-10T12:00:00.000Z");
    const firstRun = await repositories.runs.createOrReuse(
      rootKey,
      "anonymous"
    );
    const waitingRun = await repositories.runs.createOrReuse(
      altKey,
      "anonymous"
    );
    const first = {
      runId: firstRun.id,
      key: rootKey,
      requestCap: 3,
      hourlyBudget: 5,
      cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
      at
    };
    const waiting = { ...first, runId: waitingRun.id, key: altKey };
    const admitted =
      await repositories.fingerprintSweeps.requestAdmission(first);
    if (admitted.kind !== "admitted")
      throw new Error("first_sweep_not_admitted");
    await expect(
      repositories.fingerprintSweeps.requestAdmission(waiting)
    ).resolves.toMatchObject({ kind: "waiting" });

    await repositories.fingerprintSweeps.release(admitted.reservationId, at);

    await expect(
      repositories.fingerprintSweeps.admitWaiting(
        waitingRun.id,
        new Date("2026-08-10T12:01:00.000Z")
      )
    ).resolves.toEqual({ kind: "admitted" });
    await expect(
      repositories.fingerprintSweeps.requestAdmission({
        ...waiting,
        at: new Date("2026-08-10T12:01:00.000Z")
      })
    ).resolves.toMatchObject({ kind: "admitted", requestCap: 3 });
  });

  it("keeps an admitted sweep dispatch-pending until its discovery job is durably enqueued", async () => {
    // Break caught: a crash after budget reservation could lose a run before discovery is re-enqueued.
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states
      CASCADE`);
    const at = new Date("2026-08-10T12:00:00.000Z");
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await expect(
      repositories.fingerprintSweeps.requestAdmission({
        runId: run.id,
        key: rootKey,
        requestCap: 3,
        hourlyBudget: 5,
        cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
        at
      })
    ).resolves.toMatchObject({ kind: "admitted" });

    await expect(
      repositories.fingerprintSweeps.listAdmittedUndispatched(10)
    ).resolves.toEqual([run.id]);
    await repositories.fingerprintSweeps.markDispatched(run.id, at);
    await expect(
      repositories.fingerprintSweeps.listAdmittedUndispatched(10)
    ).resolves.toEqual([]);
  });

  it("does not advance cadence or retain unused capacity after an aborted sweep", async () => {
    // Break caught: aborts could consume future cadence or the entire unused reservation.
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states
      CASCADE`);
    const at = new Date("2026-08-10T12:00:00.000Z");
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const input = {
      runId: run.id,
      key: rootKey,
      requestCap: 5,
      hourlyBudget: 8,
      cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
      at
    };
    const admitted =
      await repositories.fingerprintSweeps.requestAdmission(input);
    expect(admitted).toMatchObject({ kind: "admitted" });
    if (admitted.kind !== "admitted") throw new Error("sweep_not_admitted");

    await repositories.fingerprintSweeps.recordRequest(
      admitted.reservationId,
      3,
      at
    );
    await repositories.fingerprintSweeps.release(admitted.reservationId, at);

    await expect(
      repositories.fingerprintSweeps.requestAdmission({
        ...input,
        at: new Date("2026-08-10T12:01:00.000Z")
      })
    ).resolves.toMatchObject({ kind: "admitted", requestCap: 5 });
  });

  it("returns not due only after a published sweep within its cadence", async () => {
    // Break caught: a partial, unpublished, or aborted sweep could suppress a later sweep.
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states
      CASCADE`);
    const at = new Date("2026-08-10T12:00:00.000Z");
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const admitted = await repositories.fingerprintSweeps.requestAdmission({
      runId: run.id,
      key: rootKey,
      requestCap: 1,
      hourlyBudget: 2,
      cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
      at
    });
    if (admitted.kind !== "admitted") throw new Error("sweep_not_admitted");
    await repositories.fingerprintSweeps.finish(admitted.reservationId, {
      published: true,
      at,
      limitationCode: null
    });
    await repositories.runs.fail(run.id, "upstream_unavailable");

    const nextRun = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await expect(
      repositories.fingerprintSweeps.requestAdmission({
        runId: nextRun.id,
        key: rootKey,
        requestCap: 1,
        hourlyBudget: 2,
        cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
        at: new Date("2026-08-10T12:01:00.000Z")
      })
    ).resolves.toEqual({ kind: "not_due" });
  });
});
