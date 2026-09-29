import type { CharacterKey } from "@slashwho/domain";
import type { Pool } from "pg";
import {
  createDiscoveryQueue,
  type SnapshotCharacterInput,
  type StoredSnapshot
} from "../../packages/database/src";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  eventually,
  rootKey,
  altKey,
  observation,
  seedCompleteSnapshot,
  admitSweep,
  resetRepositoryTables,
  startRepositoryDatabase
} from "./repository-fixtures";
import type { TestRepositories } from "./test-repositories";

/**
 * Discovery runs, snapshot publication and history, recent searches,
 * fingerprint sweeps and their admission, and the caches around them.
 *
 * Split from one file so each area runs in parallel with its own PostgreSQL;
 * the shared set-up is in `repository-fixtures.ts`.
 */
describe("PostgreSQL repositories: discovery runs and snapshots", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let repositories: TestRepositories;

  beforeAll(async () => {
    ({ pool, stop, repositories } = await startRepositoryDatabase());
  });

  beforeEach(async () => {
    await resetRepositoryTables(pool);
  });

  afterAll(async () => {
    await stop();
  });

  it("lists the most recently requested discovery runs first, up to the limit", async () => {
    const first = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await repositories.runs.fail(first.id, "upstream_unavailable");
    const second = await repositories.runs.createOrReuse(rootKey, "bot");
    const third = await repositories.runs.createOrReuse(altKey, "anonymous");
    // created_at defaults to now(), which a fast test can repeat; pin it so
    // the order under test is the one the rows were requested in.
    await pool.query(
      `UPDATE discovery_runs
          SET created_at = CASE id
                WHEN $1::uuid THEN '2026-09-20T10:00:00Z'::timestamptz
                WHEN $2::uuid THEN '2026-09-20T11:00:00Z'::timestamptz
                ELSE '2026-09-20T12:00:00Z'::timestamptz
              END`,
      [first.id, second.id]
    );

    const all = await repositories.runs.listRecent(50);
    const newestTwo = await repositories.runs.listRecent(2);

    expect(all.map((run) => [run.id, run.status, run.errorCode])).toEqual([
      [third.id, "queued", null],
      [second.id, "queued", null],
      [first.id, "failed", "upstream_unavailable"]
    ]);
    expect(newestTwo.map((run) => run.id)).toEqual([third.id, second.id]);
  });

  it("round-trips a character's guild through the snapshot", async () => {
    // The guild columns are written by hand-built SQL and read back by a
    // mapper that treats a partially missing guild as none. Every other
    // fixture stores null, so without this the non-null path never runs
    // against a real database.
    const guild = {
      name: "Rancour",
      region: "eu" as const,
      realm: "draenor"
    };
    await seedCompleteSnapshot(repositories, {
      characters: [
        { ...observation(rootKey, "Ryii"), guild },
        observation(altKey, "Ryalts", "claimed")
      ]
    });

    const snapshot = await repositories.snapshots.getCurrent(rootKey);

    expect(
      snapshot?.characters.map((character) => [
        character.key.name,
        character.guild
      ])
    ).toEqual([
      [rootKey.name, guild],
      [altKey.name, null]
    ]);
  });

  it("lists reverse declared-main characters only from each root's current snapshot", async () => {
    // Break caught: reverse discovery could either miss a stored cross-realm
    // edge or resurrect an edge that a newer snapshot no longer observes.
    const declaringKey = {
      region: "eu",
      realm: "silvermoon",
      name: "yawnersw"
    } as const;
    const otherDeclaringKey = {
      region: "eu",
      realm: "argent-dawn",
      name: "knownalt"
    } as const;
    const chainedDeclaringKey = {
      region: "eu",
      realm: "tarren-mill",
      name: "chainroot"
    } as const;
    const directMainKey = {
      region: "eu",
      realm: "twisting-nether",
      name: "directmain"
    } as const;
    const targetMainKey = {
      region: "eu",
      realm: "draenor",
      name: "yawnersowo"
    } as const;
    const guild = { name: "Rancour", region: "eu" as const, realm: "draenor" };

    const publish = async (
      key: CharacterKey,
      refreshedAt: Date,
      characters: SnapshotCharacterInput[]
    ) => {
      const run = await repositories.runs.createOrReuse(key, "anonymous");
      await repositories.runs.markRunning(run.id);
      const snapshot = await repositories.snapshots.create({
        runId: run.id,
        rootKey: key,
        state: "complete",
        limitationCode: null,
        refreshedAt,
        characters
      });
      await repositories.runs.complete(run.id, snapshot.id);
    };

    await publish(declaringKey, new Date("2026-09-16T10:00:00.000Z"), [
      { ...observation(declaringKey, "Yawnersw"), guild },
      observation(targetMainKey, "Yawnersowo", "declared_main")
    ]);
    await publish(declaringKey, new Date("2026-09-17T10:00:00.000Z"), [
      { ...observation(declaringKey, "Yawnersw"), guild }
    ]);
    await publish(otherDeclaringKey, new Date("2026-09-18T10:00:00.000Z"), [
      { ...observation(otherDeclaringKey, "Knownalt"), guild },
      observation(targetMainKey, "Yawnersowo", "declared_main")
    ]);
    await publish(chainedDeclaringKey, new Date("2026-09-18T11:00:00.000Z"), [
      observation(chainedDeclaringKey, "Chainroot"),
      observation(directMainKey, "Directmain", "declared_main"),
      observation(targetMainKey, "Yawnersowo", "declared_main")
    ]);

    await expect(
      repositories.snapshots.listReverseDeclaredCharacters(targetMainKey)
    ).resolves.toEqual([
      expect.objectContaining({
        key: otherDeclaringKey,
        displayName: "Knownalt",
        guild,
        source: "declared_main"
      })
    ]);
  });

  it("borrows only a current snapshot that declares the character", async () => {
    // Break caught: superseded snapshots are never deleted, so a claim a
    // newer discovery had dropped could be borrowed; and a newer inferred
    // membership elsewhere hid a declared one by winning the ordering.
    const searchedKey = {
      region: "eu",
      realm: "silvermoon",
      name: "borrowed"
    } as const;
    const droppedRootKey = {
      region: "eu",
      realm: "silvermoon",
      name: "droppedroot"
    } as const;
    const declaringRootKey = {
      region: "eu",
      realm: "draenor",
      name: "declaringroot"
    } as const;
    const inferringRootKey = {
      region: "eu",
      realm: "argent-dawn",
      name: "inferringroot"
    } as const;

    const publish = async (
      key: CharacterKey,
      refreshedAt: Date,
      characters: SnapshotCharacterInput[]
    ) => {
      const run = await repositories.runs.createOrReuse(key, "anonymous");
      await repositories.runs.markRunning(run.id);
      const snapshot = await repositories.snapshots.create({
        runId: run.id,
        rootKey: key,
        state: "complete",
        limitationCode: null,
        refreshedAt,
        characters
      });
      await repositories.runs.complete(run.id, snapshot.id);
    };

    await publish(droppedRootKey, new Date("2026-09-01T10:00:00.000Z"), [
      observation(droppedRootKey, "Droppedroot"),
      observation(searchedKey, "Borrowed", "claimed")
    ]);
    await publish(droppedRootKey, new Date("2026-09-20T10:00:00.000Z"), [
      observation(droppedRootKey, "Droppedroot")
    ]);

    await expect(
      repositories.snapshots.getCurrentDeclaringCharacter!(searchedKey)
    ).resolves.toBeNull();

    await publish(declaringRootKey, new Date("2026-09-19T10:00:00.000Z"), [
      observation(declaringRootKey, "Declaringroot"),
      observation(searchedKey, "Borrowed", "claimed")
    ]);
    await publish(inferringRootKey, new Date("2026-09-21T10:00:00.000Z"), [
      observation(inferringRootKey, "Inferringroot"),
      observation(searchedKey, "Borrowed", "fingerprint")
    ]);

    await expect(
      repositories.snapshots.getCurrentDeclaringCharacter!(searchedKey)
    ).resolves.toMatchObject({
      rootKey: declaringRootKey,
      refreshedAt: new Date("2026-09-19T10:00:00.000Z")
    });
  });

  it("lists each searched character once, newest search first", async () => {
    // Break caught: the landing page listed a character once per search, or a
    // slow request moved a newer search back behind an older one.
    const recent = repositories.recentSearches!;
    await seedCompleteSnapshot(repositories);
    await recent.record(rootKey, new Date("2026-09-26T10:00:00Z"));
    await recent.record(altKey, new Date("2026-09-26T11:00:00Z"));
    await recent.record(rootKey, new Date("2026-09-26T12:00:00Z"));
    await recent.record(rootKey, new Date("2026-09-26T09:00:00Z"));

    expect(await recent.listRecent(10)).toEqual([
      {
        key: rootKey,
        displayName: "Ryii",
        searchedAt: new Date("2026-09-26T12:00:00Z"),
        inProgress: false
      },
      {
        // Searched, but not yet created by discovery.
        key: altKey,
        displayName: null,
        searchedAt: new Date("2026-09-26T11:00:00Z"),
        inProgress: false
      }
    ]);
    expect(await recent.listRecent(1)).toHaveLength(1);
  });

  it("reports a recent search in progress while its discovery or any member's evidence is collecting", async () => {
    // Break caught: the spinner followed only the searched character's own
    // runs, so a dossier still gathering an alt's evidence read as complete.
    const recent = repositories.recentSearches!;
    await seedCompleteSnapshot(repositories, {
      characters: [
        observation(rootKey, "Ryii"),
        observation(altKey, "Other", "claimed")
      ]
    });
    await recent.record(rootKey);
    expect((await recent.listRecent(10))[0]?.inProgress).toBe(false);

    const discovery = await repositories.runs.createOrReuse(
      rootKey,
      "anonymous"
    );
    expect((await recent.listRecent(10))[0]?.inProgress).toBe(true);
    await repositories.runs.fail(discovery.id, "search_failed");
    expect((await recent.listRecent(10))[0]?.inProgress).toBe(false);

    const evidence = await repositories.evidence.reserve({
      origin: "dossier_read",
      key: altKey,
      freshnessCutoff: new Date(),
      at: new Date()
    });
    if (evidence.kind !== "reserved") throw new Error("evidence_not_reserved");
    expect((await recent.listRecent(10))[0]?.inProgress).toBe(true);
    await repositories.evidence.fail(evidence.run.id, "collection_failed");
    expect((await recent.listRecent(10))[0]?.inProgress).toBe(false);
  });

  it("leaves suppressed characters off the recent searches", async () => {
    const recent = repositories.recentSearches!;
    await recent.record(rootKey);
    await recent.record(altKey);
    await repositories.suppressions.suppress(rootKey, "removal_request", null);

    expect((await recent.listRecent(10)).map(({ key }) => key)).toEqual([
      altKey
    ]);
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

  it("stores the guild reads a run dropped, replacing an earlier attempt's count", async () => {
    // The count exists because logs rotate, so it has to survive on the row.
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const stored = async () =>
      (
        await pool.query<{ guild_reads_dropped: number }>(
          "SELECT guild_reads_dropped FROM discovery_runs WHERE id = $1",
          [run.id]
        )
      ).rows[0]?.guild_reads_dropped;

    expect(await stored()).toBe(0);
    await repositories.runs.recordGuildReadsDropped(run.id, 2);
    expect(await stored()).toBe(2);
    await repositories.runs.recordGuildReadsDropped(run.id, 0);
    expect(await stored()).toBe(0);

    await expect(
      repositories.runs.recordGuildReadsDropped(run.id, -1)
    ).rejects.toThrow("guild_reads_dropped_out_of_range");
    await expect(
      repositories.runs.recordGuildReadsDropped(
        "00000000-0000-4000-8000-000000000000",
        1
      )
    ).rejects.toThrow("discovery_run_not_found");
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
        },
        { resumeAfter: null, limitationCode: null, advanced: true }
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
        characters: [
          {
            ...observation(rootKey, "Ryii"),
            // A fingerprint match is read from the root's own guild roster, so
            // it carries a guild. This path writes through its own INSERT,
            // separate from snapshots.create.
            guild: { name: "Rancour", region: "eu", realm: "draenor" }
          }
        ]
      },
      {
        reservationId: admission.reservationId,
        finishedAt: at,
        limitationCode: null
      },
      { resumeAfter: null, limitationCode: null, advanced: true }
    );

    expect(
      (await repositories.snapshots.getCurrent(rootKey))?.characters[0]?.guild
    ).toEqual({ name: "Rancour", region: "eu", realm: "draenor" });

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

  it("treats a character that has never published a sweep as due for a visit", async () => {
    // Break caught: with no sweep-state row, the check dereferenced the
    // missing row and threw, so a visit never scheduled the first sweep.
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "neversweptroot"
    } as const;
    const cadenceCutoff = new Date("2026-08-01T12:00:00.000Z");

    await expect(
      repositories.fingerprintSweeps.isDueForVisit!(key, cadenceCutoff)
    ).resolves.toBe(true);

    const run = await repositories.runs.createOrReuse(key, "anonymous");
    await repositories.runs.markRunning(run.id);
    const at = new Date("2026-08-08T12:00:00.000Z");
    const admission = await repositories.fingerprintSweeps.requestAdmission({
      runId: run.id,
      key,
      requestCap: 1,
      hourlyBudget: 2,
      cadenceCutoff,
      at
    });
    if (admission.kind !== "admitted") throw new Error("sweep_not_admitted");
    await repositories.fingerprintSweeps.finish(admission.reservationId, {
      at,
      published: true,
      limitationCode: null
    });

    await expect(
      repositories.fingerprintSweeps.isDueForVisit!(key, cadenceCutoff)
    ).resolves.toBe(false);
    await expect(
      repositories.fingerprintSweeps.isDueForVisit!(
        key,
        new Date("2026-08-15T12:00:00.000Z")
      )
    ).resolves.toBe(true);
  });

  it("persists and clears the fingerprint sweep cursor", async () => {
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "cursorroot"
    } as const;
    const run = await repositories.runs.createOrReuse(key, "anonymous");
    await repositories.runs.markRunning(run.id);

    const admission = await repositories.fingerprintSweeps.requestAdmission({
      runId: run.id,
      key,
      requestCap: 10,
      hourlyBudget: 100,
      cadenceCutoff: new Date(Date.now() - 60_000),
      at: new Date()
    });
    if (admission.kind !== "admitted") throw new Error("sweep_not_admitted");

    const snapshot =
      await repositories.snapshots.createAndFinishFingerprintSweep(
        {
          runId: run.id,
          rootKey: key,
          state: "partial",
          limitationCode: "fingerprint_sweep_capped",
          refreshedAt: new Date(),
          characters: [observation(key, "input")]
        },
        {
          reservationId: admission.reservationId,
          finishedAt: new Date(),
          limitationCode: "fingerprint_sweep_capped"
        },
        {
          resumeAfter: JSON.stringify(["eu", "draenor", "valadares"]),
          limitationCode: "privacy_hidden",
          excludedTournamentCharacterIds: ["eu/draenor/tournamentalt"],
          advanced: true
        }
      );

    await expect(
      repositories.fingerprintSweeps.getResumeState(key)
    ).resolves.toEqual({
      resumeAfter: JSON.stringify(["eu", "draenor", "valadares"]),
      snapshotId: snapshot.id,
      // The run that published the snapshot, and so the only one allowed to
      // continue this chain.
      runId: run.id,
      limitationCode: "privacy_hidden",
      historicalGuilds: [],
      // Continuations do no discovery, so the exclusion must survive here.
      excludedTournamentCharacterIds: ["eu/draenor/tournamentalt"]
    });
  });

  it("retains a waiting continuation admission when a capped snapshot persists its cursor", async () => {
    // Break caught: publishing a capped snapshot finished its only admission;
    // the queued fingerprint-admission delivery then settled without a
    // continuation, leaving the cursor's membership vulnerable to replacement.
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states
      CASCADE`);
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "waitcursor"
    } as const;
    const at = new Date("2026-09-21T12:00:00.000Z");
    const run = await repositories.runs.createOrReuse(key, "anonymous");
    await repositories.runs.markRunning(run.id);
    const admission = await repositories.fingerprintSweeps.requestAdmission({
      runId: run.id,
      key,
      requestCap: 10,
      hourlyBudget: 100,
      cadenceCutoff: new Date(at.getTime() - 60_000),
      at
    });
    if (admission.kind !== "admitted") throw new Error("sweep_not_admitted");

    const snapshot =
      await repositories.snapshots.createAndFinishFingerprintSweep(
        {
          runId: run.id,
          rootKey: key,
          state: "partial",
          limitationCode: "fingerprint_sweep_capped",
          refreshedAt: at,
          characters: [observation(key, "input")]
        },
        {
          reservationId: admission.reservationId,
          finishedAt: at,
          limitationCode: "fingerprint_sweep_capped",
          continuationAdmission: {
            requestCap: 10,
            hourlyBudget: 100,
            cadenceCutoff: new Date(at.getTime() - 60_000)
          }
        },
        {
          resumeAfter: "eu/silvermoon/tail",
          limitationCode: null,
          advanced: true
        }
      );

    await expect(
      repositories.fingerprintSweeps.listWaiting(10)
    ).resolves.toEqual([run.id]);
    const queue = createDiscoveryQueue({
      connectionString: pool.options.connectionString!
    });
    await queue.start();
    const continuations: Array<{ continuation?: true }> = [];
    await queue.work(async (payload) => {
      continuations.push(payload);
    });
    await queue.workFingerprintAdmissions(async (runId) => {
      const admitted = await repositories.fingerprintSweeps.admitWaiting(
        runId,
        new Date(at.getTime() + 1)
      );
      if (admitted.kind !== "admitted") return;
      const resume = await repositories.fingerprintSweeps.getResumeState(key);
      await queue.enqueue({
        runId,
        key,
        enqueuedAt: new Date(at.getTime() + 1).toISOString(),
        ...(resume?.runId === runId ? { continuation: true as const } : {})
      });
      await repositories.fingerprintSweeps.markDispatched(
        runId,
        new Date(at.getTime() + 1)
      );
    });
    await queue.enqueueFingerprintAdmission(run.id);
    await eventually(async () => continuations.length === 1);
    expect(continuations).toEqual([
      expect.objectContaining({ runId: run.id, continuation: true })
    ]);
    await queue.stop({ graceful: false, timeoutMs: 1_000 });

    const fresh = await repositories.runs.createOrReuse(key, "anonymous");
    await expect(
      repositories.fingerprintSweeps.requestAdmission({
        runId: fresh.id,
        key,
        requestCap: 10,
        hourlyBudget: 100,
        cadenceCutoff: new Date(at.getTime() - 60_000),
        at: new Date(at.getTime() + 2)
      })
    ).resolves.toEqual({ kind: "not_due" });
    await expect(repositories.snapshots.getCurrent(key)).resolves.toMatchObject(
      {
        id: snapshot.id,
        characterCount: 1
      }
    );

    const continuation = await repositories.fingerprintSweeps.requestAdmission({
      runId: run.id,
      key,
      requestCap: 10,
      hourlyBudget: 100,
      cadenceCutoff: new Date(at.getTime() - 60_000),
      at: new Date(at.getTime() + 1),
      continuation: true
    });
    if (continuation.kind !== "admitted") {
      throw new Error("continuation_not_admitted");
    }
    const amended = await repositories.snapshots.amendAndFinishFingerprintSweep(
      snapshot.id,
      [
        observation(
          { region: "eu", realm: "silvermoon", name: "latermatch" },
          "fingerprint"
        )
      ],
      {
        runId: run.id,
        reservationId: continuation.reservationId,
        finishedAt: new Date(at.getTime() + 2),
        limitationCode: "privacy_hidden"
      },
      { resumeAfter: null, limitationCode: "privacy_hidden", advanced: true }
    );

    expect(amended).toMatchObject({
      characterCount: 2,
      limitationCode: "privacy_hidden"
    });
  });

  it("completes a cadence-gated fresh run against the live sweep snapshot", async () => {
    // Break caught: `complete` accepts only a snapshot the run itself
    // published, so a fresh run deferring to another run's live cursor threw
    // `discovery_run_not_found` on every attempt and failed as `search_failed`.
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states
      CASCADE`);
    const key = {
      region: "eu",
      realm: "draenor",
      name: "livecursor"
    } as const;
    const at = new Date("2026-09-26T10:00:00.000Z");
    const owner = await repositories.runs.createOrReuse(key, "anonymous");
    await repositories.runs.markRunning(owner.id);
    const admission = await repositories.fingerprintSweeps.requestAdmission({
      runId: owner.id,
      key,
      requestCap: 10,
      hourlyBudget: 100,
      cadenceCutoff: new Date(at.getTime() - 60_000),
      at
    });
    if (admission.kind !== "admitted") throw new Error("sweep_not_admitted");
    const live = await repositories.snapshots.createAndFinishFingerprintSweep(
      {
        runId: owner.id,
        rootKey: key,
        state: "partial",
        limitationCode: "fingerprint_sweep_capped",
        refreshedAt: at,
        characters: [observation(key, "Livecursor")]
      },
      {
        reservationId: admission.reservationId,
        finishedAt: at,
        limitationCode: "fingerprint_sweep_capped"
      },
      {
        resumeAfter: "eu/draenor/tail",
        limitationCode: null,
        advanced: true
      }
    );
    const unrelated = await seedCompleteSnapshot(repositories);

    const fresh = await repositories.runs.createOrReuse(key, "anonymous");
    await repositories.runs.markRunning(fresh.id);

    await expect(
      repositories.runs.completeWithLiveSweepSnapshot(fresh.id, unrelated.id)
    ).rejects.toThrow("discovery_run_not_found");
    await repositories.runs.completeWithLiveSweepSnapshot(fresh.id, live.id);
    // A redelivery after the write landed must settle, not throw.
    await repositories.runs.completeWithLiveSweepSnapshot(fresh.id, live.id);

    await expect(repositories.runs.find(fresh.id)).resolves.toMatchObject({
      status: "complete",
      snapshotId: live.id
    });
    await expect(repositories.snapshots.getCurrent(key)).resolves.toMatchObject(
      { id: live.id }
    );
    await expect(
      repositories.fingerprintSweeps.getResumeState(key)
    ).resolves.toMatchObject({ runId: owner.id, snapshotId: live.id });
  });

  it("returns no resume state when the cursor was never set", async () => {
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "nocursor"
    } as const;
    await expect(
      repositories.fingerprintSweeps.getResumeState(key)
    ).resolves.toBeNull();
  });

  it("appends characters to a published snapshot and seals the sweep", async () => {
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "amendroot"
    } as const;
    const alt = { region: "eu", realm: "draenor", name: "amendalt" } as const;
    const run = await repositories.runs.createOrReuse(key, "anonymous");
    await repositories.runs.markRunning(run.id);
    const first = await admitSweep(repositories, run.id, key);

    const published =
      await repositories.snapshots.createAndFinishFingerprintSweep(
        {
          runId: run.id,
          rootKey: key,
          state: "partial",
          limitationCode: "fingerprint_sweep_capped",
          refreshedAt: new Date(),
          characters: [observation(key, "input")]
        },
        first,
        {
          resumeAfter: JSON.stringify(["eu", "draenor", "valadares"]),
          limitationCode: null,
          advanced: true
        }
      );

    const second = await admitSweep(repositories, run.id, key);
    const amended = await repositories.snapshots.amendAndFinishFingerprintSweep(
      published.id,
      [observation(alt, "fingerprint", "fingerprint")],
      { ...second, runId: run.id, limitationCode: null },
      { resumeAfter: null, limitationCode: null, advanced: true }
    );

    expect(amended!.id).toBe(published.id);
    expect(amended!.characterCount).toBe(2);
    expect(amended!.characters.map((row) => row.key.name)).toEqual([
      "amendroot",
      "amendalt"
    ]);
    expect(amended!.limitationCode).toBeNull();
    await expect(
      repositories.fingerprintSweeps.getResumeState(key)
    ).resolves.toBeNull();
  });

  it("does not deadlock an amend against a create that shares its characters", async () => {
    // Break caught (#567): the amend upserted `characters` in input order while
    // a create sorts them by canonical key. Neither takes the other's root
    // lock, so the two could lock the same rows in opposite orders and
    // PostgreSQL aborted one with a deadlock.
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "lockorderroot"
    } as const;
    const alpha = {
      region: "eu",
      realm: "draenor",
      name: "aaalockorder"
    } as const;
    const zulu = {
      region: "eu",
      realm: "draenor",
      name: "zzzlockorder"
    } as const;
    const run = await repositories.runs.createOrReuse(key, "anonymous");
    await repositories.runs.markRunning(run.id);
    const first = await admitSweep(repositories, run.id, key);
    const published =
      await repositories.snapshots.createAndFinishFingerprintSweep(
        {
          runId: run.id,
          rootKey: key,
          state: "partial",
          limitationCode: "fingerprint_sweep_capped",
          refreshedAt: new Date(),
          characters: [observation(key, "input")]
        },
        first,
        {
          resumeAfter: JSON.stringify(["eu", "draenor", "valadares"]),
          limitationCode: null,
          advanced: true
        }
      );
    const second = await admitSweep(repositories, run.id, key);
    const other = await repositories.runs.createOrReuse(alpha, "anonymous");

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

    let results: [
      PromiseSettledResult<StoredSnapshot | null>,
      PromiseSettledResult<StoredSnapshot>
    ];
    try {
      results = await Promise.allSettled([
        repositories.snapshots.amendAndFinishFingerprintSweep(
          published.id,
          [
            observation(zulu, "Zulu", "fingerprint"),
            observation(alpha, "Alpha", "fingerprint")
          ],
          { ...second, runId: run.id, limitationCode: null },
          { resumeAfter: null, limitationCode: null, advanced: true }
        ),
        repositories.snapshots.create({
          runId: other.id,
          rootKey: alpha,
          state: "complete",
          limitationCode: null,
          refreshedAt: new Date(),
          characters: [
            observation(alpha, "Alpha"),
            observation(zulu, "Zulu", "claimed")
          ]
        })
      ]);
    } finally {
      await pool.query("DROP TRIGGER test_pause_character_write ON characters");
      await pool.query("DROP FUNCTION test_pause_character_write() CASCADE");
    }

    const [amended, created] = results;
    expect(amended.status).toBe("fulfilled");
    expect(created.status).toBe("fulfilled");
    // Lock order is canonical; display order is still the order found.
    if (amended.status === "fulfilled") {
      expect(amended.value!.characters.map(({ key }) => key)).toEqual([
        key,
        zulu,
        alpha
      ]);
    }
    if (created.status === "fulfilled") {
      expect(created.value.characters.map(({ key }) => key)).toEqual([
        alpha,
        zulu
      ]);
    }
  });

  it("ignores a character the snapshot already carries", async () => {
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "dupedroot"
    } as const;
    const run = await repositories.runs.createOrReuse(key, "anonymous");
    await repositories.runs.markRunning(run.id);
    const first = await admitSweep(repositories, run.id, key);

    const published =
      await repositories.snapshots.createAndFinishFingerprintSweep(
        {
          runId: run.id,
          rootKey: key,
          state: "partial",
          limitationCode: "fingerprint_sweep_capped",
          refreshedAt: new Date(),
          characters: [observation(key, "input")]
        },
        first,
        {
          resumeAfter: JSON.stringify(["eu", "draenor", "valadares"]),
          limitationCode: null,
          advanced: true
        }
      );

    const second = await admitSweep(repositories, run.id, key);
    const amended = await repositories.snapshots.amendAndFinishFingerprintSweep(
      published.id,
      [observation(key, "input", "fingerprint")],
      { ...second, runId: run.id, limitationCode: null },
      { resumeAfter: null, limitationCode: null, advanced: true }
    );

    expect(amended!.characterCount).toBe(1);
  });

  it("rolls back an amend wholly when the sweep cannot be finished", async () => {
    // Break caught: the appended characters commit while the reservation stays
    // open, leaving the snapshot enlarged, its count wrong and the cursor
    // unmoved -- a partial cycle no later cycle can reconcile.
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "rollbackroot"
    } as const;
    const alt = {
      region: "eu",
      realm: "draenor",
      name: "rollbackalt"
    } as const;
    const run = await repositories.runs.createOrReuse(key, "anonymous");
    await repositories.runs.markRunning(run.id);
    const first = await admitSweep(repositories, run.id, key);
    const cursor = JSON.stringify(["eu", "draenor", "valadares"]);
    const published =
      await repositories.snapshots.createAndFinishFingerprintSweep(
        {
          runId: run.id,
          rootKey: key,
          state: "partial",
          limitationCode: "fingerprint_sweep_capped",
          refreshedAt: new Date(),
          characters: [observation(key, "input")]
        },
        first,
        { resumeAfter: cursor, limitationCode: null, advanced: true }
      );

    await expect(
      repositories.snapshots.amendAndFinishFingerprintSweep(
        published.id,
        [observation(alt, "fingerprint", "fingerprint")],
        {
          runId: run.id,
          // No such reservation: the finish step throws after the characters
          // and the count update have already been written in this transaction.
          reservationId: "00000000-0000-4000-8000-000000000999",
          finishedAt: new Date(),
          limitationCode: null
        },
        { resumeAfter: null, limitationCode: null, advanced: true }
      )
    ).rejects.toThrow("fingerprint_reservation_not_active");

    const after = await repositories.snapshots.find(published.id);
    expect(after?.characterCount).toBe(1);
    expect(after?.characters.map((row) => row.key.name)).toEqual([
      "rollbackroot"
    ]);
    expect(after?.limitationCode).toBe("fingerprint_sweep_capped");
    await expect(
      repositories.fingerprintSweeps.getResumeState(key)
    ).resolves.toMatchObject({ resumeAfter: cursor });
  });

  it("refuses to amend a snapshot the cursor no longer points at", async () => {
    // Break caught: an in-flight continuation amended a snapshot a fresh
    // refresh had already superseded, and overwrote the new chain's cursor with
    // the dead one's -- destroying the live chain.
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "supersededroot"
    } as const;
    const alt = {
      region: "eu",
      realm: "draenor",
      name: "supersededalt"
    } as const;
    const first = await repositories.runs.createOrReuse(key, "anonymous");
    await repositories.runs.markRunning(first.id);
    const firstSweep = await admitSweep(repositories, first.id, key);
    const stale = await repositories.snapshots.createAndFinishFingerprintSweep(
      {
        runId: first.id,
        rootKey: key,
        state: "partial",
        limitationCode: "fingerprint_sweep_capped",
        refreshedAt: new Date(),
        characters: [observation(key, "input")]
      },
      firstSweep,
      {
        resumeAfter: JSON.stringify(["eu", "draenor", "stale"]),
        limitationCode: null,
        advanced: true
      }
    );

    const second = await repositories.runs.createOrReuse(key, "anonymous");
    await repositories.runs.markRunning(second.id);
    const secondSweep = await admitSweep(repositories, second.id, key);
    const live = await repositories.snapshots.createAndFinishFingerprintSweep(
      {
        runId: second.id,
        rootKey: key,
        state: "partial",
        limitationCode: "fingerprint_sweep_capped",
        refreshedAt: new Date(),
        characters: [observation(key, "input")]
      },
      secondSweep,
      {
        resumeAfter: JSON.stringify(["eu", "draenor", "live"]),
        limitationCode: null,
        advanced: true
      }
    );

    const thirdSweep = await admitSweep(repositories, first.id, key);
    await expect(
      repositories.snapshots.amendAndFinishFingerprintSweep(
        stale.id,
        [observation(alt, "fingerprint", "fingerprint")],
        { ...thirdSweep, runId: first.id, limitationCode: null },
        { resumeAfter: null, limitationCode: null, advanced: true }
      )
    ).resolves.toBeNull();

    await expect(repositories.snapshots.find(stale.id)).resolves.toMatchObject({
      characterCount: 1
    });
    await expect(
      repositories.fingerprintSweeps.getResumeState(key)
    ).resolves.toMatchObject({
      resumeAfter: JSON.stringify(["eu", "draenor", "live"]),
      snapshotId: live.id,
      runId: second.id
    });
  });

  it("keeps a continuation's run complete when its admission is deferred", async () => {
    // Break caught: a deferred admission reverted the run to `queued`, which a
    // continuation's complete run can never satisfy, so the repository threw
    // and the chain died exactly when the hourly budget was saturated.
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states
      CASCADE`);
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "deferredroot"
    } as const;
    const at = new Date("2026-08-10T12:00:00.000Z");
    const blockerRun = await repositories.runs.createOrReuse(
      altKey,
      "anonymous"
    );
    const run = await repositories.runs.createOrReuse(key, "anonymous");
    await repositories.runs.markRunning(run.id);
    const sweep = await admitSweep(repositories, run.id, key);
    const published =
      await repositories.snapshots.createAndFinishFingerprintSweep(
        {
          runId: run.id,
          rootKey: key,
          state: "partial",
          limitationCode: "fingerprint_sweep_capped",
          refreshedAt: at,
          characters: [observation(key, "input")]
        },
        sweep,
        {
          resumeAfter: JSON.stringify(["eu", "draenor", "valadares"]),
          limitationCode: null,
          advanced: true
        }
      );
    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "complete"
    });

    // Saturate the hourly budget so the continuation can only wait.
    const blocker = await repositories.fingerprintSweeps.requestAdmission({
      runId: blockerRun.id,
      key: altKey,
      requestCap: 3,
      hourlyBudget: 3,
      cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
      at
    });
    expect(blocker.kind).toBe("admitted");

    await expect(
      repositories.fingerprintSweeps.requestAdmission({
        runId: run.id,
        key,
        requestCap: 1,
        hourlyBudget: 3,
        cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
        at,
        continuation: true
      })
    ).resolves.toMatchObject({ kind: "waiting" });

    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "complete",
      snapshotId: published.id
    });
    await expect(
      repositories.fingerprintSweeps.getResumeState(key)
    ).resolves.toMatchObject({ snapshotId: published.id, runId: run.id });
  });

  it("leaves a cursor it does not own alone when a reservation is finished", async () => {
    // Break caught: `finish` cleared the resume columns unconditionally, so any
    // caller finishing a reservation for this root would wipe a live chain.
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "finishroot"
    } as const;
    const run = await repositories.runs.createOrReuse(key, "anonymous");
    await repositories.runs.markRunning(run.id);
    const first = await admitSweep(repositories, run.id, key);
    const cursor = JSON.stringify(["eu", "draenor", "valadares"]);
    await repositories.snapshots.createAndFinishFingerprintSweep(
      {
        runId: run.id,
        rootKey: key,
        state: "partial",
        limitationCode: "fingerprint_sweep_capped",
        refreshedAt: new Date(),
        characters: [observation(key, "input")]
      },
      first,
      { resumeAfter: cursor, limitationCode: null, advanced: true }
    );

    const second = await admitSweep(repositories, run.id, key);
    await repositories.fingerprintSweeps.finish(second.reservationId, {
      published: true,
      at: new Date(),
      limitationCode: null
    });

    await expect(
      repositories.fingerprintSweeps.getResumeState(key)
    ).resolves.toMatchObject({ resumeAfter: cursor });
  });

  it("counts only continuation cycles that made no progress", async () => {
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "failureroot"
    } as const;
    const run = await repositories.runs.createOrReuse(key, "anonymous");
    await repositories.runs.markRunning(run.id);
    const first = await admitSweep(repositories, run.id, key);
    await repositories.snapshots.createAndFinishFingerprintSweep(
      {
        runId: run.id,
        rootKey: key,
        state: "partial",
        limitationCode: "fingerprint_sweep_capped",
        refreshedAt: new Date(),
        characters: [observation(key, "input")]
      },
      first,
      {
        resumeAfter: JSON.stringify(["eu", "draenor", "one"]),
        limitationCode: null,
        advanced: true
      }
    );

    await expect(
      repositories.fingerprintSweeps.recordContinuationFailure(key)
    ).resolves.toBe(1);
    await expect(
      repositories.fingerprintSweeps.recordContinuationFailure(key)
    ).resolves.toBe(2);

    // A cycle that does not advance preserves the count...
    const stalled = await admitSweep(repositories, run.id, key);
    await repositories.snapshots.amendAndFinishFingerprintSweep(
      (await repositories.fingerprintSweeps.getResumeState(key))!.snapshotId,
      [],
      { ...stalled, runId: run.id, limitationCode: "fingerprint_sweep_capped" },
      {
        resumeAfter: JSON.stringify(["eu", "draenor", "one"]),
        limitationCode: null,
        advanced: false
      }
    );
    await expect(
      repositories.fingerprintSweeps.recordContinuationFailure(key)
    ).resolves.toBe(3);

    // ...and one that does advance clears it.
    const advancing = await admitSweep(repositories, run.id, key);
    await repositories.snapshots.amendAndFinishFingerprintSweep(
      (await repositories.fingerprintSweeps.getResumeState(key))!.snapshotId,
      [],
      {
        ...advancing,
        runId: run.id,
        limitationCode: "fingerprint_sweep_capped"
      },
      {
        resumeAfter: JSON.stringify(["eu", "draenor", "two"]),
        limitationCode: null,
        advanced: true
      }
    );
    await expect(
      repositories.fingerprintSweeps.recordContinuationFailure(key)
    ).resolves.toBe(1);
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

  it("prunes fingerprint request events only once they leave the rolling hour", async () => {
    // Break caught: one row per Blizzard request accumulates without limit, and
    // a prune keyed on the reservation would delete events the rolling-hour
    // budget still has to count.
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_request_events,
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states
      CASCADE`);
    const sweptRun = await repositories.runs.createOrReuse(
      rootKey,
      "anonymous"
    );
    const admitted = await repositories.fingerprintSweeps.requestAdmission({
      runId: sweptRun.id,
      key: rootKey,
      requestCap: 3,
      hourlyBudget: 3,
      cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
      at: new Date("2026-08-10T12:00:00.000Z")
    });
    if (admitted.kind !== "admitted") throw new Error("sweep_not_admitted");
    await repositories.fingerprintSweeps.recordRequest(
      admitted.reservationId,
      1,
      new Date("2026-08-10T12:10:00.000Z")
    );
    const lastRequestedAt = new Date("2026-08-10T12:55:00.000Z");
    await repositories.fingerprintSweeps.recordRequest(
      admitted.reservationId,
      2,
      lastRequestedAt
    );
    await repositories.fingerprintSweeps.release(
      admitted.reservationId,
      lastRequestedAt
    );
    await repositories.runs.fail(sweptRun.id, "upstream_unavailable");

    const at = new Date("2026-08-10T13:20:00.000Z");
    await expect(
      repositories.fingerprintSweeps.cleanupExpired(at)
    ).resolves.toBe(1);
    const retained = await pool.query<{ requested_at: Date }>(
      `SELECT requested_at FROM fingerprint_sweep_request_events
       ORDER BY requested_at`
    );
    expect(retained.rows.map((row) => row.requested_at)).toEqual([
      lastRequestedAt,
      lastRequestedAt
    ]);

    const nextRun = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await expect(
      repositories.fingerprintSweeps.requestAdmission({
        runId: nextRun.id,
        key: rootKey,
        requestCap: 2,
        hourlyBudget: 3,
        cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
        at
      })
    ).resolves.toMatchObject({
      kind: "waiting",
      retryAt: new Date("2026-08-10T13:55:00.000Z")
    });
  });

  it("retains each physical fingerprint request for its own rolling hour", async () => {
    // Break caught: extending a reservation expiry from its admission time can
    // undercount late Profile API requests and admit a budget-overlapping sweep.
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_request_events,
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states
      CASCADE`);
    const admittedAt = new Date("2026-08-10T12:00:00.000Z");
    const firstRun = await repositories.runs.createOrReuse(
      rootKey,
      "anonymous"
    );
    const admitted = await repositories.fingerprintSweeps.requestAdmission({
      runId: firstRun.id,
      key: rootKey,
      requestCap: 3,
      hourlyBudget: 3,
      cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
      at: admittedAt
    });
    if (admitted.kind !== "admitted") throw new Error("sweep_not_admitted");
    const usedAt = new Date("2026-08-10T12:55:00.000Z");
    await repositories.fingerprintSweeps.recordRequest(
      admitted.reservationId,
      3,
      usedAt
    );
    await repositories.fingerprintSweeps.release(
      admitted.reservationId,
      usedAt
    );
    await repositories.runs.fail(firstRun.id, "upstream_unavailable");

    const secondRun = await repositories.runs.createOrReuse(
      rootKey,
      "anonymous"
    );
    await expect(
      repositories.fingerprintSweeps.requestAdmission({
        runId: secondRun.id,
        key: rootKey,
        requestCap: 1,
        hourlyBudget: 3,
        cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
        at: new Date("2026-08-10T13:10:00.000Z")
      })
    ).resolves.toMatchObject({
      kind: "waiting",
      retryAt: new Date("2026-08-10T13:55:00.000Z")
    });
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

  it("keeps answering not due for a deferred run until it leaves the queue", async () => {
    // Break caught: admission settled a deferred run as not due on its first
    // attempt only. When dispatching it then failed, the retried admission
    // found no waiting row and answered `settled`, so nothing dispatched the
    // run and it stayed `queued` with no snapshot for good.
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states
      CASCADE`);
    const at = new Date("2026-08-10T12:00:00.000Z");
    const cadenceCutoff = new Date("2026-08-03T12:00:00.000Z");
    const sweeper = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const sweep = await repositories.fingerprintSweeps.requestAdmission({
      runId: sweeper.id,
      key: rootKey,
      requestCap: 1,
      hourlyBudget: 1,
      cadenceCutoff,
      at
    });
    if (sweep.kind !== "admitted") throw new Error("sweep_not_admitted");
    await repositories.runs.fail(sweeper.id, "upstream_unavailable");

    const deferred = await repositories.runs.createOrReuse(
      rootKey,
      "anonymous"
    );
    await repositories.runs.markRunning(deferred.id);
    await expect(
      repositories.fingerprintSweeps.requestAdmission({
        runId: deferred.id,
        key: rootKey,
        requestCap: 1,
        hourlyBudget: 1,
        cadenceCutoff,
        at: new Date(at.getTime() + 1_000)
      })
    ).resolves.toMatchObject({ kind: "waiting" });
    // The root is swept while the deferred run waits.
    await repositories.fingerprintSweeps.finish(sweep.reservationId, {
      published: true,
      at: new Date(at.getTime() + 2_000),
      limitationCode: null
    });

    const retryAt = new Date(at.getTime() + 3_000);
    await expect(
      repositories.fingerprintSweeps.admitWaiting(deferred.id, retryAt)
    ).resolves.toEqual({ kind: "not_due" });
    // A retry after a failed dispatch still has to dispatch the run.
    await expect(
      repositories.fingerprintSweeps.admitWaiting(deferred.id, retryAt)
    ).resolves.toEqual({ kind: "not_due" });
    await expect(repositories.runs.find(deferred.id)).resolves.toMatchObject({
      status: "queued"
    });

    // Once the run has left the queue there is nothing left to dispatch.
    await repositories.runs.fail(deferred.id, "upstream_unavailable");
    await expect(
      repositories.fingerprintSweeps.admitWaiting(deferred.id, retryAt)
    ).resolves.toEqual({ kind: "settled" });
  });

  it("admits a continuation inside the cadence window", async () => {
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states
      CASCADE`);
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "cadenceroot"
    } as const;
    const run = await repositories.runs.createOrReuse(key, "anonymous");
    await repositories.runs.markRunning(run.id);
    const at = new Date();

    const first = await repositories.fingerprintSweeps.requestAdmission({
      runId: run.id,
      key,
      requestCap: 10,
      hourlyBudget: 100,
      cadenceCutoff: new Date(at.getTime() - 60_000),
      at
    });
    expect(first.kind).toBe("admitted");
    await repositories.fingerprintSweeps.finish(
      (first as { reservationId: string }).reservationId,
      { published: true, at, limitationCode: "fingerprint_sweep_capped" }
    );

    // Same cadence window: an ordinary request is not due...
    await expect(
      repositories.fingerprintSweeps.requestAdmission({
        runId: run.id,
        key,
        requestCap: 10,
        hourlyBudget: 100,
        cadenceCutoff: new Date(at.getTime() - 60_000),
        at
      })
    ).resolves.toMatchObject({ kind: "not_due" });

    // ...but a continuation is admitted.
    await expect(
      repositories.fingerprintSweeps.requestAdmission({
        runId: run.id,
        key,
        requestCap: 10,
        hourlyBudget: 100,
        cadenceCutoff: new Date(at.getTime() - 60_000),
        at,
        continuation: true
      })
    ).resolves.toMatchObject({ kind: "admitted" });
  });
});
