import type { CharacterKey } from "@slashwho/domain";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresRepositories,
  runMigrations,
  type Repositories,
  type CharacterMythicKillInput,
  type CharacterMythicWipeInput,
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
    guild: null,
    raiderIoUrl: `https://raider.io/characters/${key.region}/${key.realm}/${key.name}`,
    source
  };
}

function mythicKill(
  overrides: Partial<CharacterMythicKillInput> = {}
): CharacterMythicKillInput {
  const { performance: overridePerformance, ...restOverrides } = overrides;
  return {
    raidId: "42",
    raidName: "Nerub-ar Palace",
    bossId: "1234",
    bossName: "Queen Ansurek",
    journalBossId: "3014",
    bossOrder: 8,
    isFinalBoss: true,
    killedAt: "2026-08-04T12:00:00.000Z",
    reportUrl: "https://www.warcraftlogs.com/reports/example",
    fightUrl: "https://www.warcraftlogs.com/reports/example#fight=1",
    guild: { name: "Example Guild", realm: "silvermoon" },
    historicWorldRank: null,
    performance: {
      spec: null,
      damage: { state: "unavailable" },
      healing: { state: "unavailable" },
      bossDamage: { state: "unavailable" },
      ...overridePerformance
    },
    ...restOverrides
  };
}

function mythicWipe(
  overrides: Partial<CharacterMythicWipeInput> = {}
): CharacterMythicWipeInput {
  return {
    raidId: "42",
    raidName: "Nerub-ar Palace",
    bossId: "1233",
    bossName: "Nexus-Princess Ky'veza",
    journalBossId: "2920",
    bossOrder: 6,
    attemptedAt: "2026-08-04T11:00:00.000Z",
    reportUrl: "https://www.warcraftlogs.com/reports/wipe",
    fightUrl: "https://www.warcraftlogs.com/reports/wipe#fight=1",
    ...overrides
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

async function admitSweep(
  repositories: Repositories,
  runId: string,
  key: CharacterKey
): Promise<{
  reservationId: string;
  finishedAt: Date;
  limitationCode: string | null;
}> {
  const at = new Date();
  const admission = await repositories.fingerprintSweeps.requestAdmission({
    runId,
    key,
    requestCap: 10,
    hourlyBudget: 100,
    // A cutoff ahead of `at` keeps the cadence gate open, so this helper can be
    // called twice for the same root without depending on Task 5.
    cadenceCutoff: new Date(at.getTime() + 60_000),
    at
  });
  if (admission.kind !== "admitted") throw new Error("not admitted");
  return {
    reservationId: admission.reservationId,
    finishedAt: new Date(),
    limitationCode: "fingerprint_sweep_capped"
  };
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
      character_mythic_kills,
      character_mythic_wipes,
      character_evidence_runs,
      snapshot_characters,
      snapshots,
      discovery_runs,
      characters,
      suppressed_characters,
      negative_character_cache,
      rate_limit_events,
      manual_dossier_connections
      CASCADE`);
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

  it("keeps enriched parses when a later complete run did not re-fetch them", async () => {
    // Break caught: collection deliberately skips fights whose parses are
    // already stored, but the merge only ran for a partial publish. A complete
    // run therefore wrote those fights back blank, deleting the very parses the
    // skip existed to preserve.
    const enriched = mythicKill({
      performance: {
        spec: {
          name: "Assassination",
          iconUrl:
            "https://wow.zamimg.com/images/wow/icons/medium/ability_rogue_deadlybrew.jpg"
        },
        damage: { state: "available", percentile: 91 },
        healing: { state: "available", percentile: 82 },
        bossDamage: { state: "available", percentile: 87 }
      }
    });
    const first = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (first.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(first.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [enriched],
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-08-04T12:05:00.000Z")
    });

    // The same fight, re-found by a run that skipped it as already hydrated.
    const second = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T13:00:00.000Z"),
      at: new Date("2026-08-04T13:00:00.000Z")
    });
    if (second.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(second.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-08-04T13:05:00.000Z")
    });

    const stored = await repositories.evidence.getCompleted(rootKey);
    expect(stored?.kills).toHaveLength(1);
    expect(stored?.kills[0]?.performance).toMatchObject({
      spec: { name: "Assassination" },
      damage: { state: "available", percentile: 91 },
      healing: { state: "available", percentile: 82 },
      bossDamage: { state: "available", percentile: 87 }
    });
  });

  it("carries forward tier bests for zones a later run did not read", async () => {
    // Break caught: one run reads only the newest few zones, so a publish that
    // did not reach a zone would blank a best parse it already holds.
    const manaforge = {
      raidId: "44",
      raidName: "Manaforge Omega",
      bossId: "3129",
      bossName: "Plexus Sentinel",
      rankingsUrl:
        "https://www.warcraftlogs.com/character/eu/silvermoon/ryii#zone=44&boss=3129&difficulty=5",
      performance: {
        spec: {
          name: "Destruction",
          iconUrl:
            "https://wow.zamimg.com/images/wow/icons/medium/spell_shadow_rainoffire.jpg"
        },
        damage: { state: "available", percentile: 96.2 },
        healing: { state: "unavailable" },
        bossDamage: { state: "available", percentile: 91 }
      }
    } as const;
    const sporefall = {
      ...manaforge,
      raidId: "45",
      raidName: "Sporefall",
      bossId: "3300",
      bossName: "Rootbound Warden",
      rankingsUrl:
        "https://www.warcraftlogs.com/character/eu/silvermoon/ryii#zone=45&boss=3300&difficulty=5",
      performance: {
        spec: null,
        damage: { state: "available", percentile: 55 },
        healing: { state: "unavailable" },
        bossDamage: { state: "unavailable" }
      }
    } as const;

    const first = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (first.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(first.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [],
      wipes: [],
      tierBests: [manaforge, sporefall],
      completedAt: new Date("2026-08-04T12:05:00.000Z")
    });

    // A later run whose budget reached only the newest zone.
    const second = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T13:00:00.000Z"),
      at: new Date("2026-08-04T13:00:00.000Z")
    });
    if (second.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(second.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [],
      wipes: [],
      tierBests: [
        {
          ...manaforge,
          performance: {
            ...manaforge.performance,
            damage: { state: "available", percentile: 98 }
          }
        }
      ],
      completedAt: new Date("2026-08-04T13:05:00.000Z")
    });

    const stored = await repositories.evidence.getCompleted(rootKey);
    expect(
      stored?.tierBests.map((tierBest) => [
        tierBest.raidId,
        tierBest.bossId,
        tierBest.performance.damage
      ])
    ).toEqual([
      ["44", "3129", { state: "available", percentile: 98 }],
      ["45", "3300", { state: "available", percentile: 55 }]
    ]);
  });

  it("keeps enriched parses when a later partial run cannot re-enrich them", async () => {
    // Break caught: a rate-limited re-collection re-found the same kills without
    // parse data and overwrote richer stored rows, losing specs and percentiles.
    const enriched = mythicKill({
      performance: {
        spec: {
          name: "Assassination",
          iconUrl:
            "https://wow.zamimg.com/images/wow/icons/medium/ability_rogue_deadlybrew.jpg"
        },
        damage: { state: "available", percentile: 91 },
        healing: { state: "available", percentile: 82 },
        bossDamage: { state: "available", percentile: 87 }
      }
    });
    const first = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (first.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(first.run.id, {
      state: "partial",
      limitationCode: "parse_request_cap",
      parseLimitationCode: null,
      kills: [enriched],
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-08-04T12:05:00.000Z")
    });

    // The same fight, re-found by a rate-limited run that enriched nothing.
    const second = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T13:00:00.000Z"),
      at: new Date("2026-08-04T13:00:00.000Z")
    });
    if (second.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(second.run.id, {
      state: "partial",
      limitationCode: "parse_rate_limited",
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-08-04T13:05:00.000Z")
    });

    const stored = await repositories.evidence.getCompleted(rootKey);
    expect(stored?.kills).toHaveLength(1);
    expect(stored?.kills[0]?.performance).toMatchObject({
      spec: { name: "Assassination" },
      damage: { state: "available", percentile: 91 },
      healing: { state: "available", percentile: 82 },
      bossDamage: { state: "available", percentile: 87 }
    });
  });

  it("reports only the fight URLs whose parses are already stored", async () => {
    // Break caught: without this the parse budget redid the same reports every
    // run, so coverage never advanced past whatever the first run reached.
    const hydrated = mythicKill({
      fightUrl: "https://www.warcraftlogs.com/reports/example#fight=hydrated",
      performance: {
        spec: null,
        damage: { state: "available", percentile: 91 },
        healing: { state: "unavailable" },
        bossDamage: { state: "unavailable" }
      }
    });
    const bare = mythicKill({
      fightUrl: "https://www.warcraftlogs.com/reports/example#fight=bare"
    });
    const reservation = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (reservation.kind !== "reserved")
      throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(reservation.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [hydrated, bare],
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-08-04T12:05:00.000Z")
    });

    await expect(
      repositories.evidence.hydratedFightUrls(
        rootKey,
        new Date("2026-09-18T00:00:00.000Z")
      )
    ).resolves.toEqual([
      "https://www.warcraftlogs.com/reports/example#fight=hydrated"
    ]);
  });

  it("reports when each zone's tier bests were last collected", async () => {
    // Break caught: the zone list was rebuilt whole every run, so a veteran
    // always exceeded the zone budget and raised `parse_request_cap` however
    // saturated it was -- and a cap that never clears cannot carry a retry.
    const tierBest = (raidId: string, bossId: string) =>
      ({
        raidId,
        raidName: `Raid ${raidId}`,
        bossId,
        bossName: `Boss ${bossId}`,
        rankingsUrl: `https://www.warcraftlogs.com/character/eu/silvermoon/ryii#zone=${raidId}&boss=${bossId}&difficulty=5`,
        performance: {
          spec: null,
          damage: { state: "available", percentile: 60 },
          healing: { state: "unavailable" },
          bossDamage: { state: "unavailable" }
        }
      }) as const;

    const first = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (first.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(first.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [],
      wipes: [],
      tierBests: [tierBest("44", "3129")],
      completedAt: new Date("2026-08-04T12:05:00.000Z")
    });

    // A later run that reached a second zone. The first zone's rows are
    // carried forward by `publish`, so it stays collected -- at its own,
    // earlier time, not this run's.
    const second = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T13:00:00.000Z"),
      at: new Date("2026-08-04T13:00:00.000Z")
    });
    if (second.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(second.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [],
      wipes: [],
      tierBests: [tierBest("45", "3300")],
      completedAt: new Date("2026-08-04T13:05:00.000Z")
    });

    await expect(
      repositories.evidence.collectedTierZones(rootKey)
    ).resolves.toEqual([
      // Zone 44 keeps the time it was actually read, not the later run's.
      ["44", "2026-08-04T12:05:00.000Z"],
      ["45", "2026-08-04T13:05:00.000Z"]
    ]);
  });

  it("does not report a fight whose parse only exists on a superseded run", async () => {
    // Break caught: hydration was reported from every run ever, so a fight the
    // newest run stores blank was skipped forever and the dossier stayed empty.
    const fightUrl =
      "https://www.warcraftlogs.com/reports/example#fight=superseded";
    const first = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (first.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(first.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [
        mythicKill({
          fightUrl,
          performance: {
            spec: null,
            damage: { state: "available", percentile: 91 },
            healing: { state: "unavailable" },
            bossDamage: { state: "unavailable" }
          }
        })
      ],
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-08-04T12:05:00.000Z")
    });

    const second = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T13:00:00.000Z"),
      at: new Date("2026-08-04T13:00:00.000Z")
    });
    if (second.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(second.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill({ fightUrl })],
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-08-04T13:05:00.000Z")
    });

    // The parse carry-forward added in #252 now stops a publish reaching this
    // state, but the runs written blank before it exist in production and are
    // what the dossier reads. Blanking the newest run's row reproduces them.
    await pool.query(
      `UPDATE character_mythic_kills
       SET damage_parse_state = 'unavailable', damage_percentile = NULL
       WHERE evidence_run_id = $1`,
      [second.run.id]
    );

    const stored = await repositories.evidence.getCompleted(rootKey);
    const hydrated = await repositories.evidence.hydratedFightUrls(
      rootKey,
      new Date("2026-09-18T00:00:00.000Z")
    );
    expect(stored?.kills[0]?.performance.damage).toEqual({
      state: "unavailable"
    });
    expect(hydrated).not.toContain(fightUrl);
  });

  it("carries the character's class onto a claimed evidence run", async () => {
    // Break caught: Warcraft Logs omits a class on its ranks, so evidence
    // collection needs the stored class to settle shared specialisation names.
    await seedCompleteSnapshot(repositories);
    const reservation = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (reservation.kind !== "reserved")
      throw new Error("evidence_not_reserved");

    const claimed = await repositories.evidence.claim(reservation.run.id, 1);

    expect(claimed?.className).toBe("Mage");
    await expect(
      repositories.evidence.find(reservation.run.id)
    ).resolves.toMatchObject({ className: "Mage" });
  });

  it("reports a running collection alongside evidence that is still fresh", async () => {
    // Break caught: `reserve` answered "fresh" and returned before it ever
    // looked for a running collection, so the dossier a refresh had just
    // started reported no gathering at all -- and the refresh button that
    // started it stayed enabled.
    const first = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (first.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(first.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [mythicWipe()],
      tierBests: [],
      completedAt: new Date("2026-08-04T12:00:00.000Z")
    });

    // What the refresh button does: a cutoff of `at` leaves nothing fresh.
    const refresh = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T12:30:00.000Z"),
      at: new Date("2026-08-04T12:30:00.000Z")
    });
    if (refresh.kind !== "reserved") throw new Error("evidence_not_reserved");

    // What a dossier read does, concurrently, with the normal window.
    const read = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-03T12:30:00.000Z"),
      at: new Date("2026-08-04T12:30:00.000Z")
    });

    expect(read.kind).toBe("fresh");
    expect(read.active?.id).toBe(refresh.run.id);
    expect(read.completed?.run.id).toBe(first.run.id);
  });

  it("reports no running collection when fresh evidence is simply at rest", async () => {
    const first = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (first.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(first.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [mythicWipe()],
      tierBests: [],
      completedAt: new Date("2026-08-04T12:00:00.000Z")
    });

    const read = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-03T12:30:00.000Z"),
      at: new Date("2026-08-04T12:30:00.000Z")
    });

    expect(read.kind).toBe("fresh");
    expect(read.active).toBeNull();
  });

  it("retains the last completed evidence while a stale character refresh is active", async () => {
    // Break caught: a refresh could make previously completed dossier evidence
    // disappear until its replacement scan finishes.
    const completedAt = new Date("2026-08-04T12:00:00.000Z");
    const first = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: completedAt
    });
    if (first.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(first.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [mythicWipe()],
      tierBests: [],
      completedAt
    });

    const refresh = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T12:01:00.000Z"),
      at: new Date("2026-08-04T13:00:00.000Z")
    });

    expect(refresh).toMatchObject({
      kind: "reserved",
      completed: {
        run: { id: first.run.id, status: "complete" },
        kills: [mythicKill()],
        wipes: [mythicWipe()]
      }
    });
    await expect(
      repositories.evidence.getCompleted(rootKey)
    ).resolves.toMatchObject({
      run: { id: first.run.id, status: "complete" },
      kills: [mythicKill()],
      wipes: [mythicWipe()]
    });
    await expect(
      repositories.evidence.reserve({
        key: rootKey,
        freshnessCutoff: new Date("2026-08-04T12:01:00.000Z"),
        at: new Date("2026-08-04T13:01:00.000Z")
      })
    ).resolves.toMatchObject({
      kind: "active",
      run: { id: refresh.run.id, status: "queued" },
      completed: { run: { id: first.run.id } }
    });
  });

  it("refreshes evidence produced before the fight-parse cache version", async () => {
    // Break caught: deploying a parse decoder fix could leave every previously
    // cached kill fresh forever, so the worker would never recompute its metrics.
    const completedAt = new Date("2026-08-04T12:00:00.000Z");
    const first = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: completedAt
    });
    if (first.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(first.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [],
      tierBests: [],
      completedAt
    });
    await pool.query(
      "UPDATE character_evidence_runs SET evidence_version = 2 WHERE id = $1",
      [first.run.id]
    );

    await expect(
      repositories.evidence.reserve({
        key: rootKey,
        freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
        at: new Date("2026-08-04T13:00:00.000Z")
      })
    ).resolves.toMatchObject({
      kind: "reserved",
      completed: { run: { id: first.run.id }, kills: [mythicKill()] }
    });
  });

  it("re-collects evidence recorded at the previous evidence version", async () => {
    // Break caught: continuation amends a snapshot's character set after
    // evidence was already published, so a dossier's evidence run can be
    // "complete" yet stamped with the version current before that bump.
    // Bumping CURRENT_EVIDENCE_VERSION must make that stale run collect again
    // rather than serving a partial cached set forever.
    const completedAt = new Date("2026-08-04T12:00:00.000Z");
    const first = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: completedAt
    });
    if (first.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(first.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [],
      tierBests: [],
      completedAt
    });
    await pool.query(
      "UPDATE character_evidence_runs SET evidence_version = 10 WHERE id = $1",
      [first.run.id]
    );

    await expect(
      repositories.evidence.reserve({
        key: rootKey,
        freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
        at: new Date("2026-08-04T13:00:00.000Z")
      })
    ).resolves.toMatchObject({
      kind: "reserved",
      completed: { run: { id: first.run.id }, kills: [mythicKill()] }
    });
  });

  it("persists every distinct wipe fight for one boss", async () => {
    // Break caught: a per-boss uniqueness key silently dropped earlier wipes,
    // even though the dossier must show the complete report history.
    const reservation = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (reservation.kind !== "reserved")
      throw new Error("evidence_not_reserved");

    await repositories.evidence.publish(reservation.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [],
      wipes: [
        mythicWipe(),
        mythicWipe({
          attemptedAt: "2026-08-04T10:00:00.000Z",
          fightUrl: "https://www.warcraftlogs.com/reports/wipe#fight=2"
        })
      ],
      tierBests: [],
      completedAt: new Date("2026-08-04T12:00:00.000Z")
    });

    await expect(
      repositories.evidence.getCompleted(rootKey)
    ).resolves.toMatchObject({
      wipes: [
        expect.objectContaining({
          fightUrl: "https://www.warcraftlogs.com/reports/wipe#fight=1"
        }),
        expect.objectContaining({
          fightUrl: "https://www.warcraftlogs.com/reports/wipe#fight=2"
        })
      ]
    });
  });

  it("atomically publishes a complete replacement evidence scan", async () => {
    // Break caught: a reader could observe a completed run with only part of
    // its normalized WCL fights after a worker crashes during persistence.
    const reserved = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T12:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (reserved.kind !== "reserved") throw new Error("evidence_not_reserved");

    await repositories.evidence.publish(reserved.run.id, {
      state: "partial",
      limitationCode: "request_cap",
      parseLimitationCode: null,
      tierBests: [],
      completedAt: new Date("2026-08-04T12:05:00.000Z"),
      kills: [
        mythicKill(),
        mythicKill({
          bossId: "1235",
          bossName: "Silken Court",
          bossOrder: 7,
          fightUrl: "https://www.warcraftlogs.com/reports/example#fight=2"
        })
      ],
      wipes: [mythicWipe()]
    });

    await expect(repositories.evidence.getCompleted(rootKey)).resolves.toEqual({
      run: expect.objectContaining({
        id: reserved.run.id,
        status: "partial",
        limitationCode: "request_cap"
      }),
      evidenceVersion: 13,
      kills: [
        expect.objectContaining({ bossId: "1234", bossOrder: 8 }),
        expect.objectContaining({ bossId: "1235", bossOrder: 7 })
      ],
      wipes: [expect.objectContaining({ bossId: "1233", bossOrder: 6 })],
      tierBests: [],
      wipeCapable: true
    });
  });

  it("carries terminal-tier kills and wipes through a complete publish", async () => {
    // Break caught: once collection stops paging into a concluded tier, that
    // tier's kills are "not found" on every later run, and a complete publish
    // would erase a character's whole history the first time it settled.
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "terminalcarry"
    } as const;
    const first = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date("2026-09-18T00:00:00.000Z"),
      at: new Date("2026-09-18T00:00:00.000Z")
    });
    await repositories.evidence.publish(first.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      tierBests: [],
      completedAt: new Date("2026-09-18T00:00:00.000Z"),
      kills: [
        mythicKill({
          raidId: "42",
          fightUrl: "https://www.warcraftlogs.com/reports/settled#fight=1"
        }),
        mythicKill({
          raidId: "99",
          bossId: "555",
          fightUrl: "https://www.warcraftlogs.com/reports/current#fight=1"
        })
      ],
      wipes: [
        mythicWipe({
          raidId: "42",
          fightUrl: "https://www.warcraftlogs.com/reports/settled#fight=2"
        })
      ]
    });

    await repositories.evidence.markTerminalTiers(
      key,
      [{ raidId: "42", domain: "kills" }],
      new Date("2026-09-18T00:05:00.000Z")
    );

    // The second run never re-reads raid 42 -- that is what the mark is for --
    // so it reports only raid 99. Raid 42 must survive anyway.
    const second = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date("2026-09-19T00:00:00.000Z"),
      at: new Date("2026-09-19T00:00:00.000Z")
    });
    await repositories.evidence.publish(second.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      tierBests: [],
      completedAt: new Date("2026-09-19T00:00:00.000Z"),
      kills: [
        mythicKill({
          raidId: "99",
          bossId: "555",
          fightUrl: "https://www.warcraftlogs.com/reports/current#fight=1"
        })
      ],
      wipes: []
    });

    const completed = await repositories.evidence.getCompleted(key);
    expect(completed?.kills.map((kill) => kill.fightUrl).sort()).toEqual([
      "https://www.warcraftlogs.com/reports/current#fight=1",
      "https://www.warcraftlogs.com/reports/settled#fight=1"
    ]);
    expect(completed?.wipes.map((wipe) => wipe.fightUrl)).toEqual([
      "https://www.warcraftlogs.com/reports/settled#fight=2"
    ]);
  });

  it("still drops a non-terminal tier's kills a complete run no longer finds", async () => {
    // The existing contract the carry-forward must not swallow: a report made
    // private in a tier still being collected stops being claimed.
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "nonterminaldrop"
    } as const;
    const first = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date("2026-09-18T00:00:00.000Z"),
      at: new Date("2026-09-18T00:00:00.000Z")
    });
    await repositories.evidence.publish(first.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      tierBests: [],
      completedAt: new Date("2026-09-18T00:00:00.000Z"),
      kills: [mythicKill({ raidId: "99" })],
      wipes: []
    });

    const second = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date("2026-09-19T00:00:00.000Z"),
      at: new Date("2026-09-19T00:00:00.000Z")
    });
    await repositories.evidence.publish(second.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      tierBests: [],
      completedAt: new Date("2026-09-19T00:00:00.000Z"),
      kills: [],
      wipes: []
    });

    await expect(
      repositories.evidence
        .getCompleted(key)
        .then((completed) => completed?.kills)
    ).resolves.toEqual([]);
  });

  it("keeps a carried kill's observation time rather than restamping it", async () => {
    // A restamp would say every untouched fight was just re-read, which
    // destroys the drift measurement the column exists for.
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "observedat"
    } as const;
    const firstAt = new Date("2026-09-18T12:00:00.000Z");
    const secondAt = new Date("2026-09-19T12:00:00.000Z");
    const reserved = await repositories.evidence.reserve({
      key,
      freshnessCutoff: firstAt,
      at: firstAt
    });
    await repositories.evidence.publish(reserved.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      tierBests: [],
      completedAt: firstAt,
      kills: [
        mythicKill({
          raidId: "42",
          performance: {
            damage: { state: "available", percentile: 95 },
            healing: { state: "unavailable" },
            bossDamage: { state: "unavailable" }
          }
        })
      ],
      wipes: []
    });

    await repositories.evidence.markTerminalTiers(
      key,
      [{ raidId: "42", domain: "kills" }],
      firstAt
    );

    const next = await repositories.evidence.reserve({
      key,
      freshnessCutoff: secondAt,
      at: secondAt
    });
    await repositories.evidence.publish(next.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      tierBests: [],
      completedAt: secondAt,
      kills: [],
      wipes: []
    });

    const stored = await pool.query<{ collected_at: Date }>(
      `SELECT k.collected_at
         FROM character_mythic_kills k
         JOIN character_evidence_runs r ON r.id = k.evidence_run_id
        WHERE r.region = $1 AND r.realm_slug = $2 AND r.normalized_name = $3
        ORDER BY r.completed_at DESC
        LIMIT 1`,
      [key.region, key.realm, key.name]
    );
    expect(stored.rows[0]?.collected_at).toEqual(firstAt);
  });

  it("stores terminal tiers per character and returns them until cleared", async () => {
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "terminalmarks"
    } as const;
    const at = new Date("2026-09-18T10:00:00.000Z");

    await expect(repositories.evidence.terminalTiers(key)).resolves.toEqual([]);

    await repositories.evidence.markTerminalTiers(
      key,
      [
        { raidId: "42", domain: "kills" },
        { raidId: "42", domain: "parses" },
        { raidId: "43", domain: "tier_bests" }
      ],
      at
    );

    await expect(repositories.evidence.terminalTiers(key)).resolves.toEqual([
      { raidId: "42", domain: "kills" },
      { raidId: "42", domain: "parses" },
      { raidId: "43", domain: "tier_bests" }
    ]);

    // Marking again must be idempotent rather than a duplicate-key failure: a
    // run re-reads a tier it had already settled whenever a rebuild drains.
    await repositories.evidence.markTerminalTiers(
      key,
      [{ raidId: "42", domain: "kills" }],
      at
    );
    await expect(
      repositories.evidence.terminalTiers(key)
    ).resolves.toHaveLength(3);

    await expect(repositories.evidence.clearTerminalTiers(key)).resolves.toBe(
      3
    );
    await expect(repositories.evidence.terminalTiers(key)).resolves.toEqual([]);
  });

  it("forgets marks on a rebuild without discarding the evidence they cover", async () => {
    // A rebuild must not leave a dossier empty while it waits for the
    // replacement evidence to arrive.
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "rebuildkeeps"
    } as const;
    const at = new Date("2026-09-18T12:00:00.000Z");
    const reserved = await repositories.evidence.reserve({
      key,
      freshnessCutoff: at,
      at
    });
    await repositories.evidence.publish(reserved.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      tierBests: [],
      completedAt: at,
      kills: [mythicKill({ raidId: "42" })],
      wipes: [mythicWipe({ raidId: "42" })]
    });
    await repositories.evidence.markTerminalTiers(
      key,
      [
        { raidId: "42", domain: "kills" },
        { raidId: "42", domain: "parses" }
      ],
      at
    );

    await expect(repositories.evidence.clearTerminalTiers(key)).resolves.toBe(
      2
    );

    await expect(repositories.evidence.terminalTiers(key)).resolves.toEqual([]);
    const completed = await repositories.evidence.getCompleted(key);
    expect(completed?.kills).toHaveLength(1);
    expect(completed?.wipes).toHaveLength(1);
  });

  it("keeps one character's terminal tiers out of another's", async () => {
    const mine = {
      region: "eu",
      realm: "silvermoon",
      name: "marksmine"
    } as const;
    const theirs = {
      region: "eu",
      realm: "silvermoon",
      name: "markstheirs"
    } as const;
    const at = new Date("2026-09-18T10:00:00.000Z");

    await repositories.evidence.markTerminalTiers(
      mine,
      [{ raidId: "42", domain: "kills" }],
      at
    );

    await expect(repositories.evidence.terminalTiers(theirs)).resolves.toEqual(
      []
    );
    await expect(
      repositories.evidence.clearTerminalTiers(theirs)
    ).resolves.toBe(0);
    await expect(
      repositories.evidence.terminalTiers(mine)
    ).resolves.toHaveLength(1);
  });

  it("omits a terminal tier recorded below its domain's collection version", async () => {
    // Per-domain versions: a parse fix bumps `parses` and re-collects parses
    // alone, leaving kills and tier bests settled. A global bump cannot serve
    // this -- it invalidates everything, which is ruinous once the whole point
    // is to stop re-querying.
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "domainbump"
    } as const;
    await pool.query(
      `INSERT INTO character_terminal_tiers
         (region, realm_slug, normalized_name, raid_id, domain, collection_version)
       VALUES ($1, $2, $3, '42', 'parses', 0), ($1, $2, $3, '42', 'kills', 1)`,
      [key.region, key.realm, key.name]
    );

    await expect(repositories.evidence.terminalTiers(key)).resolves.toEqual([
      { raidId: "42", domain: "kills" }
    ]);
  });

  it("recovers complete evidence hidden behind a legacy partial refresh", async () => {
    const first = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (first.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(first.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [mythicWipe()],
      tierBests: [],
      completedAt: new Date("2026-08-04T12:00:00.000Z")
    });
    await pool.query(
      `INSERT INTO character_evidence_runs
        (region, realm_slug, normalized_name, status, limitation_code, completed_at)
       VALUES ($1, $2, $3, 'partial', 'request_cap', $4)`,
      [
        rootKey.region,
        rootKey.realm,
        rootKey.name,
        new Date("2026-08-04T12:30:00.000Z")
      ]
    );
    const refresh = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T12:31:00.000Z"),
      at: new Date("2026-08-04T13:00:00.000Z")
    });
    if (refresh.kind !== "reserved") throw new Error("evidence_not_reserved");

    await repositories.evidence.publish(refresh.run.id, {
      state: "partial",
      limitationCode: "schema_drift",
      parseLimitationCode: null,
      kills: [],
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-08-04T13:01:00.000Z")
    });

    await expect(
      repositories.evidence.getCompleted(rootKey)
    ).resolves.toMatchObject({
      run: { id: refresh.run.id, status: "partial" },
      kills: [mythicKill()],
      wipes: [mythicWipe()],
      wipeCapable: true
    });
  });

  it("marks pre-wipe-schema evidence as incapable of negative conclusions", async () => {
    const reserved = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (reserved.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(reserved.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-08-04T12:00:00.000Z")
    });
    await pool.query(
      "UPDATE character_evidence_runs SET evidence_version = 1 WHERE id = $1",
      [reserved.run.id]
    );

    await expect(
      repositories.evidence.getCompleted(rootKey)
    ).resolves.toMatchObject({
      wipeCapable: false,
      kills: [mythicKill()]
    });
  });

  it("validates independent history and parse limitation publication states", async () => {
    // Break caught: adding a second limitation channel could reject valid
    // complete/partial states or permit an ambiguous partial publication.
    const cases = [
      {
        state: "complete" as const,
        limitationCode: null,
        parseLimitationCode: null
      },
      {
        state: "partial" as const,
        limitationCode: "request_cap",
        parseLimitationCode: null
      },
      {
        state: "complete" as const,
        limitationCode: null,
        parseLimitationCode: "parse_request_cap"
      },
      {
        state: "partial" as const,
        limitationCode: "request_cap",
        parseLimitationCode: "parse_request_cap"
      },
      // A run whose only shortfall is its parse budget. The history scan
      // finished, so `limitation_code` is rightly null -- the negative
      // conclusions that rest on it stand -- but the run did not finish, and
      // #280 made it say so. Rejecting this shape is what broke every capped
      // run in #290.
      {
        state: "partial" as const,
        limitationCode: null,
        parseLimitationCode: "parse_request_cap"
      }
    ];
    for (const [index, input] of cases.entries()) {
      const key = { ...rootKey, name: `limitation-${index}` };
      const reserved = await repositories.evidence.reserve({
        key,
        freshnessCutoff: new Date("2026-08-04T12:00:00.000Z"),
        at: new Date("2026-08-04T12:00:00.000Z")
      });
      if (reserved.kind !== "reserved")
        throw new Error("evidence_not_reserved");
      await repositories.evidence.publish(reserved.run.id, {
        ...input,
        kills: [],
        wipes: [],
        tierBests: [],
        completedAt: new Date("2026-08-04T12:05:00.000Z")
      });
      await expect(
        repositories.evidence.find(reserved.run.id)
      ).resolves.toMatchObject({
        status: input.state,
        limitationCode: input.limitationCode,
        parseLimitationCode: input.parseLimitationCode
      });
    }
    for (const [index, input] of [
      {
        state: "complete" as const,
        limitationCode: "request_cap",
        parseLimitationCode: null
      },
      // Partial with no shortfall of either kind: the state says the run fell
      // short and nothing says of what, which is the ambiguity the invariant
      // exists to reject.
      {
        state: "partial" as const,
        limitationCode: null,
        parseLimitationCode: null
      }
    ].entries()) {
      const reserved = await repositories.evidence.reserve({
        key: { ...rootKey, name: `invalid-limitation-${index}` },
        freshnessCutoff: new Date("2026-08-04T12:00:00.000Z"),
        at: new Date("2026-08-04T12:00:00.000Z")
      });
      if (reserved.kind !== "reserved")
        throw new Error("evidence_not_reserved");
      await expect(
        repositories.evidence.publish(reserved.run.id, {
          ...input,
          kills: [],
          wipes: [],
          tierBests: [],
          completedAt: new Date("2026-08-04T12:05:00.000Z")
        })
      ).rejects.toThrow("character_evidence_publication_invalid");
    }
  });

  it("round-trips normalized kill parses", async () => {
    // Break caught: storage could lose a normalized parse state or percentile,
    // including a valid zero, while replacing a completed evidence scan.
    const initial = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T12:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (initial.kind !== "reserved") throw new Error("evidence_not_reserved");

    const initialKills = [
      mythicKill({
        performance: {
          damage: { state: "available", percentile: 0 },
          healing: { state: "not_applicable" },
          bossDamage: { state: "unavailable" }
        }
      }),
      mythicKill({
        bossId: "1235",
        bossName: "Silken Court",
        bossOrder: 7,
        fightUrl: "https://www.warcraftlogs.com/reports/example#fight=2",
        performance: {
          damage: { state: "available", percentile: 99.25 },
          healing: { state: "unavailable" },
          bossDamage: { state: "not_applicable" }
        }
      })
    ];
    await repositories.evidence.publish(initial.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: initialKills,
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-08-04T12:05:00.000Z")
    });

    const replacement = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T12:06:00.000Z"),
      at: new Date("2026-08-04T12:06:00.000Z")
    });
    if (replacement.kind !== "reserved") {
      throw new Error("replacement_not_reserved");
    }

    const withoutIds = (kills: readonly { id: string }[]) =>
      kills.map((kill) => {
        const { id, ...withoutId } = kill;
        void id;
        return withoutId;
      });
    await expect(
      repositories.evidence.getCompleted(rootKey)
    ).resolves.toMatchObject({
      run: { id: initial.run.id },
      kills: initialKills
    });
    expect(
      withoutIds((await repositories.evidence.getCompleted(rootKey))!.kills)
    ).toEqual(initialKills);

    const replacementKills = [
      mythicKill({
        bossId: "1236",
        bossName: "The Bloodbound Horror",
        bossOrder: 1,
        fightUrl: "https://www.warcraftlogs.com/reports/example#fight=3",
        performance: {
          damage: { state: "not_applicable" },
          healing: { state: "available", percentile: 99.25 },
          bossDamage: { state: "available", percentile: 0 }
        }
      })
    ];
    await repositories.evidence.publish(replacement.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: replacementKills,
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-08-04T12:10:00.000Z")
    });

    const completed = await repositories.evidence.getCompleted(rootKey);
    expect(completed?.run.id).toBe(replacement.run.id);
    expect(withoutIds(completed!.kills)).toEqual(replacementKills);
  });

  it("rejects an invalid normalized parse before publication", async () => {
    // Break caught: an out-of-range parse percentile could reach persistence
    // and violate the normalized state/value contract.
    const reserved = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T12:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (reserved.kind !== "reserved") throw new Error("evidence_not_reserved");

    await expect(
      repositories.evidence.publish(reserved.run.id, {
        state: "complete",
        limitationCode: null,
        parseLimitationCode: null,
        kills: [
          mythicKill({
            performance: {
              damage: { state: "available", percentile: 100.01 },
              healing: { state: "unavailable" },
              bossDamage: { state: "unavailable" }
            }
          })
        ],
        wipes: [],
        tierBests: [],
        completedAt: new Date("2026-08-04T12:05:00.000Z")
      })
    ).rejects.toThrow(RangeError);
    await expect(
      repositories.evidence.find(reserved.run.id)
    ).resolves.toMatchObject({
      status: "queued"
    });
  });

  it("rejects null percentiles for available parse states", async () => {
    // Break caught: PostgreSQL CHECK treats a null available percentile as
    // unknown unless the available branch requires a concrete value.
    const reserved = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T12:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (reserved.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(reserved.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [
        mythicKill({
          performance: {
            damage: { state: "available", percentile: 0 },
            healing: { state: "available", percentile: 0 },
            bossDamage: { state: "available", percentile: 0 }
          }
        })
      ],
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-08-04T12:05:00.000Z")
    });
    const completed = await repositories.evidence.getCompleted(rootKey);
    const kill = completed?.kills[0];
    if (!kill) throw new Error("published_kill_missing");
    expect(kill.performance).toEqual({
      spec: null,
      damage: { state: "available", percentile: 0 },
      healing: { state: "available", percentile: 0 },
      bossDamage: { state: "available", percentile: 0 }
    });

    for (const percentileColumn of [
      "damage_percentile",
      "healing_percentile",
      "boss_damage_percentile"
    ]) {
      await expect(
        pool.query(
          `UPDATE character_mythic_kills
           SET ${percentileColumn} = NULL
           WHERE id = $1`,
          [kill.id]
        )
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("stores encrypted WCL credentials only when the reservation creates a new run", async () => {
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "Testcharacter"
    } as const;
    const reservation = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date(0),
      at: new Date(),
      credentials: {
        wclClientIdEncrypted: "encrypted-id",
        wclClientSecretEncrypted: "encrypted-secret"
      }
    });
    expect(reservation.kind).toBe("reserved");
    expect(reservation.run.wclClientIdEncrypted).toBe("encrypted-id");
    expect(reservation.run.wclClientSecretEncrypted).toBe("encrypted-secret");
  });

  it("clears encrypted WCL credentials when a run is published", async () => {
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "Testcharacter2"
    } as const;
    const reservation = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date(0),
      at: new Date(),
      credentials: {
        wclClientIdEncrypted: "encrypted-id",
        wclClientSecretEncrypted: "encrypted-secret"
      }
    });
    await repositories.evidence.claim(reservation.run.id, 1);
    await repositories.evidence.publish(reservation.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [],
      wipes: [],
      tierBests: [],
      completedAt: new Date()
    });
    const found = await repositories.evidence.find(reservation.run.id);
    expect(found?.wclClientIdEncrypted).toBeNull();
    expect(found?.wclClientSecretEncrypted).toBeNull();
  });

  it("clears encrypted WCL credentials when a run fails", async () => {
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "Testcharacter3"
    } as const;
    const reservation = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date(0),
      at: new Date(),
      credentials: {
        wclClientIdEncrypted: "encrypted-id",
        wclClientSecretEncrypted: "encrypted-secret"
      }
    });
    await repositories.evidence.claim(reservation.run.id, 1);
    await repositories.evidence.fail(reservation.run.id, "some_error");
    const found = await repositories.evidence.find(reservation.run.id);
    expect(found?.wclClientIdEncrypted).toBeNull();
    expect(found?.wclClientSecretEncrypted).toBeNull();
  });

  it("clears stale encrypted WCL credentials left behind by an abandoned run", async () => {
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "Testcharacter4"
    } as const;
    const reservation = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date(0),
      at: new Date(),
      credentials: {
        wclClientIdEncrypted: "encrypted-id",
        wclClientSecretEncrypted: "encrypted-secret"
      }
    });
    await repositories.evidence.claim(reservation.run.id, 1);
    // Simulate the job never reaching publish()/fail() (a crash, a timeout,
    // the process being killed) by backdating created_at past the window. An
    // active run is swept on the longer cutoff, so this must outlive that one.
    await pool.query(
      `UPDATE character_evidence_runs SET created_at = $2 WHERE id = $1`,
      [reservation.run.id, new Date(Date.now() - 8 * 60 * 60_000)]
    );

    const removed = await repositories.evidence.clearStaleCredentials({
      settled: new Date(Date.now() - 60 * 60_000),
      active: new Date(Date.now() - 6 * 60 * 60_000)
    });

    expect(removed).toBe(1);
    const found = await repositories.evidence.find(reservation.run.id);
    expect(found?.wclClientIdEncrypted).toBeNull();
    expect(found?.wclClientSecretEncrypted).toBeNull();
  });

  it("keeps credentials on a run that is still waiting to retry", async () => {
    // Break caught: the sweep had no status filter, so a run deferred by a
    // points-budget refusal -- up to five attempts of 1800s -- crossed the
    // one-hour cutoff while still live. Its next attempt found no credentials,
    // silently fell back to the worker's shared account, and spent the wrong
    // allowance on a visitor's dossier.
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "Testcharacter14"
    } as const;
    const reservation = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date(0),
      at: new Date(),
      credentials: {
        wclClientIdEncrypted: "encrypted-id",
        wclClientSecretEncrypted: "encrypted-secret"
      }
    });
    await repositories.evidence.claim(reservation.run.id, 1);
    await pool.query(
      `UPDATE character_evidence_runs
       SET status = 'retrying', created_at = $2
       WHERE id = $1`,
      [reservation.run.id, new Date(Date.now() - 2 * 60 * 60_000)]
    );

    const removed = await repositories.evidence.clearStaleCredentials({
      settled: new Date(Date.now() - 60 * 60_000),
      active: new Date(Date.now() - 6 * 60 * 60_000)
    });

    expect(removed).toBe(0);
    const found = await repositories.evidence.find(reservation.run.id);
    expect(found?.wclClientIdEncrypted).toBe("encrypted-id");
    expect(found?.wclClientSecretEncrypted).toBe("encrypted-secret");
  });

  it("records a limitation on an active run and clears it on the next claim", async () => {
    // Break caught: a refusal publishes nothing, so this is the only way a
    // deferral reaches a reader. Left uncleared it would outlive the attempt
    // that recorded it and describe a run that is collecting normally.
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "Testcharacter15"
    } as const;
    const reservation = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date(0),
      at: new Date()
    });
    await repositories.evidence.claim(reservation.run.id, 1);

    await repositories.evidence.recordLimitation(
      reservation.run.id,
      "points_budget_low"
    );
    expect(
      (await repositories.evidence.find(reservation.run.id))?.limitationCode
    ).toBe("points_budget_low");

    await repositories.evidence.claim(reservation.run.id, 2);
    expect(
      (await repositories.evidence.find(reservation.run.id))?.limitationCode
    ).toBeNull();
  });

  it("leaves credentials on runs created after the cutoff untouched", async () => {
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "Testcharacter5"
    } as const;
    const reservation = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date(0),
      at: new Date(),
      credentials: {
        wclClientIdEncrypted: "encrypted-id",
        wclClientSecretEncrypted: "encrypted-secret"
      }
    });

    const removed = await repositories.evidence.clearStaleCredentials({
      settled: new Date(Date.now() - 60 * 60_000),
      active: new Date(Date.now() - 6 * 60 * 60_000)
    });

    expect(removed).toBe(0);
    const found = await repositories.evidence.find(reservation.run.id);
    expect(found?.wclClientIdEncrypted).toBe("encrypted-id");
    expect(found?.wclClientSecretEncrypted).toBe("encrypted-secret");
  });

  describe("manual dossier connections", () => {
    const pendingKey = {
      region: "eu",
      realm: "silvermoon",
      name: "undiscovered"
    } as const;

    it("links a character that has not been discovered yet", async () => {
      // Break caught: the insert used to join `characters` twice, so a target
      // with no row yielded no rows and was reported as a duplicate. A
      // reviewer could not link a character before its discovery finished.
      await seedCompleteSnapshot(repositories);

      await expect(
        repositories.manualConnections.add(rootKey, pendingKey)
      ).resolves.toBe("added");

      const listed = await repositories.manualConnections.list(rootKey);
      expect(listed).toEqual([
        {
          key: pendingKey,
          displayName: "undiscovered",
          className: null,
          level: 0,
          raiderIoUrl:
            "https://raider.io/characters/eu/silvermoon/undiscovered",
          pending: true,
          excluded: false
        }
      ]);
    });

    it("reports a repeated link as a duplicate rather than adding it twice", async () => {
      await seedCompleteSnapshot(repositories);
      await repositories.manualConnections.add(rootKey, pendingKey);

      await expect(
        repositories.manualConnections.add(rootKey, pendingKey)
      ).resolves.toBe("duplicate");
      expect(await repositories.manualConnections.list(rootKey)).toHaveLength(
        1
      );
    });

    it("resolves the character once discovery creates it", async () => {
      // Break caught: the link is stored by key, so it has to pick up the real
      // display name, class and level on its own as soon as the character
      // exists, with no second write and no backfill step.
      await seedCompleteSnapshot(repositories);
      await repositories.manualConnections.add(rootKey, altKey);

      expect(await repositories.manualConnections.list(rootKey)).toMatchObject([
        { pending: true, className: null, level: 0 }
      ]);

      const run = await repositories.runs.createOrReuse(altKey, "anonymous");
      await repositories.runs.markRunning(run.id);
      const snapshot = await repositories.snapshots.create({
        runId: run.id,
        rootKey: altKey,
        state: "complete",
        limitationCode: null,
        refreshedAt: new Date(),
        characters: [observation(altKey, "Other")]
      });
      await repositories.runs.complete(run.id, snapshot.id);

      expect(await repositories.manualConnections.list(rootKey)).toEqual([
        {
          key: altKey,
          displayName: "Other",
          className: "Mage",
          level: 80,
          raiderIoUrl: "https://raider.io/characters/us/area-52/other",
          pending: false,
          excluded: false
        }
      ]);
    });

    it("withholds a connection whose character has an active removal request", async () => {
      await seedCompleteSnapshot(repositories);
      await repositories.manualConnections.add(rootKey, pendingKey);
      await repositories.suppressions.suppress(pendingKey, "removal", null);

      expect(await repositories.manualConnections.list(rootKey)).toEqual([]);
    });

    it("marks a connection as excluded and restores it again", async () => {
      await seedCompleteSnapshot(repositories);
      await repositories.manualConnections.add(rootKey, pendingKey);

      await expect(
        repositories.manualConnections.setExcluded(rootKey, pendingKey, true)
      ).resolves.toBe("updated");
      expect(await repositories.manualConnections.list(rootKey)).toMatchObject([
        { excluded: true }
      ]);

      await expect(
        repositories.manualConnections.setExcluded(rootKey, pendingKey, false)
      ).resolves.toBe("updated");
      expect(await repositories.manualConnections.list(rootKey)).toMatchObject([
        { excluded: false }
      ]);
    });

    it("reports an exclusion of a character that is not linked as missing", async () => {
      // Two reviewers can hold the same dossier, so the second must be told
      // the link has gone rather than shown a change it did not make.
      await seedCompleteSnapshot(repositories);

      await expect(
        repositories.manualConnections.setExcluded(rootKey, pendingKey, true)
      ).resolves.toBe("missing");
    });

    it("unlinks a connection without touching the character or its snapshot", async () => {
      await seedCompleteSnapshot(repositories, {
        characters: [observation(rootKey, "Ryii"), observation(altKey, "Other")]
      });
      await repositories.manualConnections.add(rootKey, altKey);

      await expect(
        repositories.manualConnections.remove(rootKey, altKey)
      ).resolves.toBe("removed");

      expect(await repositories.manualConnections.list(rootKey)).toEqual([]);
      // #186: removal unlinks, it does not delete the discovered character or
      // the snapshot that found it.
      const snapshot = await repositories.snapshots.getCurrent(rootKey);
      expect(
        snapshot?.characters.map((character) => character.key.name)
      ).toContain(altKey.name);
    });

    it("reports a removal of a character that is not linked as missing", async () => {
      await seedCompleteSnapshot(repositories);

      await expect(
        repositories.manualConnections.remove(rootKey, pendingKey)
      ).resolves.toBe("missing");
    });

    it("keeps an exclusion scoped to the dossier it was made on", async () => {
      // A connection is stored per root, so excluding a character on one
      // applicant's dossier must say nothing about anyone else's.
      await seedCompleteSnapshot(repositories, {
        characters: [observation(rootKey, "Ryii"), observation(altKey, "Other")]
      });
      await repositories.manualConnections.add(rootKey, pendingKey);
      await repositories.manualConnections.add(altKey, pendingKey);

      await repositories.manualConnections.setExcluded(
        rootKey,
        pendingKey,
        true
      );

      expect(await repositories.manualConnections.list(altKey)).toMatchObject([
        { excluded: false }
      ]);
    });
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
      limitationCode: "privacy_hidden"
    });
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
