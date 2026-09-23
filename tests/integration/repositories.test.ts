import { readFileSync } from "node:fs";

import {
  createApplicantEvidenceJobHandler,
  recoverAbandonedEvidenceRuns
} from "../../packages/application/src";
import type { CharacterKey } from "@slashwho/domain";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresRepositories,
  createDiscoveryQueue,
  runMigrations,
  type Repositories,
  type CharacterMythicKillInput,
  type CharacterMythicWipeInput,
  type EvidenceRunCost,
  type SnapshotCharacterInput,
  type StoredSnapshot
} from "../../packages/database/src";
import type { WarcraftLogsGateway } from "../../packages/warcraftlogs/src";
import { startPostgres } from "./postgres";

/**
 * The fenced SQL blocks in an operations document, in order. The queries in
 * `docs/operations/evidence-run-cost.md` are run from the document itself so
 * that a column renamed out from under them fails the suite rather than
 * leaving a document that quietly stopped being true.
 */
const SQL_BLOCK = /```sql\n([\s\S]*?)```/g;

async function eventually(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed_out");
}

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
    killedAt: "2026-08-04T12:00:00.000Z",
    reportUrl: "https://www.warcraftlogs.com/reports/example",
    fightUrl: "https://www.warcraftlogs.com/reports/example#fight=1",
    guild: { name: "Example Guild", region: "eu", realm: "silvermoon" },
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
      -- Keyed by character rather than by run, so nothing above cascades to
      -- it and a mark left by one test would be read by the next.
      character_terminal_tiers,
      snapshot_characters,
      snapshots,
      discovery_runs,
      characters,
      suppressed_characters,
      negative_character_cache,
      rate_limit_events,
      manual_dossier_connections,
      operator_auth_events,
      operator_login_attempts,
      operator_sessions,
      operators
      CASCADE`);
  });

  async function provisionOperator() {
    return repositories.operatorAuth.provision({
      canonicalLogin: "operator_one",
      displayLogin: "Operator One",
      passwordHash: "derived-password-hash",
      passwordSalt: "derived-password-salt",
      scryptVersion: 1,
      scryptCost: 16_384,
      at: new Date("2026-09-21T12:00:00.000Z")
    });
  }

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

  it("round-trips a Mythic kill's Warcraft Logs guild region", async () => {
    // Historical-guild traversal can only safely call Blizzard when the
    // region was observed with the public report; a realm alone is ambiguous.
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
      kills: [
        mythicKill({
          guild: { name: "Rancour", region: "eu", realm: "draenor" }
        })
      ],
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-08-04T12:05:00.000Z")
    });

    expect(
      (await repositories.evidence.getCompleted(rootKey))?.kills[0]?.guild
    ).toEqual({
      name: "Rancour",
      region: "eu",
      realm: "draenor"
    });
  });

  it("commits an evidence run with its reserved phase plan", async () => {
    // Break caught: a process dying after reservation but before worker claim
    // used to leave no ledger at all, so an operator could not distinguish a
    // queued run from one whose progress writer had failed.
    const reservation = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-09-22T10:00:00.000Z"),
      at: new Date("2026-09-22T11:00:00.000Z"),
      phasePlan: [
        "warcraft_logs_history",
        "warcraft_logs_tier_bests",
        "warcraft_logs_fight_parses",
        "warcraft_logs_ranking_identities",
        "publication"
      ]
    });
    if (reservation.kind !== "reserved")
      throw new Error("evidence_not_reserved");

    await expect(
      repositories.evidence.listPhases?.(reservation.run.id)
    ).resolves.toEqual([
      expect.objectContaining({
        id: "warcraft_logs_history",
        ordinal: 1,
        state: "pending"
      }),
      expect.objectContaining({
        id: "warcraft_logs_tier_bests",
        ordinal: 2,
        state: "pending"
      }),
      expect.objectContaining({
        id: "warcraft_logs_fight_parses",
        ordinal: 3,
        state: "pending"
      }),
      expect.objectContaining({
        id: "warcraft_logs_ranking_identities",
        ordinal: 4,
        state: "pending"
      }),
      expect.objectContaining({
        id: "publication",
        ordinal: 5,
        state: "pending"
      })
    ]);
  });

  it("records a stopped collection as failed publication in the same transaction", async () => {
    const reservation = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-09-22T10:00:00.000Z"),
      at: new Date("2026-09-22T11:00:00.000Z"),
      phasePlan: ["publication"]
    });
    if (reservation.kind !== "reserved")
      throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(reservation.run.id, {
      state: "partial",
      limitationCode: "collection_failed",
      parseLimitationCode: null,
      kills: [],
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-09-22T11:05:00.000Z")
    });
    await expect(
      repositories.evidence.listPhases?.(reservation.run.id)
    ).resolves.toEqual([
      expect.objectContaining({
        id: "publication",
        state: "failed",
        limitationCode: "collection_failed"
      })
    ]);
  });

  it("settles publication when a run fails before it can publish", async () => {
    const reservation = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-09-22T10:00:00.000Z"),
      at: new Date("2026-09-22T11:00:00.000Z"),
      phasePlan: ["publication"]
    });
    if (reservation.kind !== "reserved")
      throw new Error("evidence_not_reserved");
    await repositories.evidence.fail(reservation.run.id, "collection_failed");
    await expect(
      repositories.evidence.find(reservation.run.id)
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "collection_failed"
    });
    await expect(
      repositories.evidence.listPhases?.(reservation.run.id)
    ).resolves.toEqual([
      expect.objectContaining({
        id: "publication",
        state: "failed",
        limitationCode: "collection_failed"
      })
    ]);
  });

  it("reopens a limited evidence phase on retry and records its recovered result", async () => {
    const reservation = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-09-22T10:00:00.000Z"),
      at: new Date("2026-09-22T11:00:00.000Z"),
      phasePlan: [
        "warcraft_logs_identity_resolution",
        "warcraft_logs_history",
        "publication"
      ]
    });
    if (reservation.kind !== "reserved")
      throw new Error("evidence_not_reserved");

    const recordTransition = async (
      state: "active" | "limited" | "completed",
      at: Date,
      limitationCode: string | null = null
    ) =>
      repositories.evidence.recordPhaseTransitions?.(reservation.run.id, [
        {
          id: "warcraft_logs_identity_resolution",
          state,
          startedAt: new Date("2026-09-22T11:01:00.000Z"),
          completedAt: state === "active" ? null : at,
          limitationCode
        }
      ]);

    await recordTransition("active", new Date("2026-09-22T11:01:00.000Z"));
    await recordTransition(
      "limited",
      new Date("2026-09-22T11:02:00.000Z"),
      "not_found"
    );
    await recordTransition("active", new Date("2026-09-22T11:03:00.000Z"));
    await recordTransition("completed", new Date("2026-09-22T11:04:00.000Z"));

    await expect(
      repositories.evidence.listPhases?.(reservation.run.id)
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "warcraft_logs_identity_resolution",
          state: "completed",
          startedAt: new Date("2026-09-22T11:01:00.000Z"),
          completedAt: new Date("2026-09-22T11:04:00.000Z"),
          limitationCode: null
        })
      ])
    );
  });

  it("publishes normalized Blizzard achievements with the evidence run", async () => {
    // Break caught: a provider phase that does not publish its normalized
    // result only recreates the same network call on every dossier read.
    const reservation = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-09-22T10:00:00.000Z"),
      at: new Date("2026-09-22T11:00:00.000Z"),
      phasePlan: ["blizzard_achievements", "publication"]
    });
    if (reservation.kind !== "reserved")
      throw new Error("evidence_not_reserved");

    await repositories.evidence.recordPhaseTransitions?.(reservation.run.id, [
      {
        id: "blizzard_achievements",
        state: "active",
        startedAt: new Date("2026-09-22T11:01:00.000Z"),
        completedAt: null,
        limitationCode: null
      }
    ]);
    await repositories.evidence.recordPhaseTransitions?.(reservation.run.id, [
      {
        id: "blizzard_achievements",
        state: "completed",
        startedAt: new Date("2026-09-22T11:01:00.000Z"),
        completedAt: new Date("2026-09-22T11:04:00.000Z"),
        limitationCode: null
      }
    ]);

    await repositories.evidence.publish(reservation.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [],
      wipes: [],
      tierBests: [],
      cuttingEdges: [
        { achievementId: "40254", completedAt: "2025-01-14T20:30:00.000Z" }
      ],
      completedAt: new Date("2026-09-22T11:05:00.000Z")
    } as never);

    expect(await repositories.evidence.getCompleted(rootKey)).toMatchObject({
      cuttingEdgesCollected: true,
      cuttingEdges: [
        { achievementId: "40254", completedAt: "2025-01-14T20:30:00.000Z" }
      ]
    });
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

  it("replaces stored parse rows with newly available specialization data", async () => {
    // Break caught: an old parse row without specialization data can only be
    // repaired if the refreshed answer wins the per-fight merge. Enough fights
    // here that the carry-forward path cannot accidentally preserve a richer
    // arbitrary prior copy instead.
    const fights = 30;
    const start = Date.parse("2026-08-04T12:00:00.000Z");
    const blank = Array.from({ length: fights }, (_, index) =>
      mythicKill({
        bossId: String(1000 + index),
        killedAt: new Date(start - (fights - index) * 86_400_000).toISOString(),
        fightUrl: `https://www.warcraftlogs.com/reports/example#fight=${index}`
      })
    );
    const enriched = blank.map((kill) =>
      mythicKill({
        bossId: kill.bossId,
        killedAt: kill.killedAt,
        fightUrl: kill.fightUrl,
        performance: {
          spec: {
            name: "Assassination",
            iconUrl:
              "https://wow.zamimg.com/images/wow/icons/medium/ability_rogue_deadlybrew.jpg"
          },
          damage: { state: "available", percentile: 77 },
          healing: { state: "unavailable" },
          bossDamage: { state: "unavailable" }
        }
      })
    );

    const publish = async (
      kills: readonly CharacterMythicKillInput[],
      minute: number,
      state: "complete" | "partial"
    ) => {
      const at = new Date(start + minute * 60_000);
      const reservation = await repositories.evidence.reserve({
        key: rootKey,
        freshnessCutoff: new Date(at.getTime() - 60_000),
        at
      });
      if (reservation.kind !== "reserved") {
        throw new Error("evidence_not_reserved");
      }
      await repositories.evidence.publish(reservation.run.id, {
        state,
        limitationCode: null,
        parseLimitationCode: state === "partial" ? "parse_request_cap" : null,
        kills: [...kills],
        wipes: [],
        tierBests: [],
        completedAt: new Date(at.getTime() + 30_000)
      });
    };

    // The baseline found every fight but held no parses for them yet.
    await publish(blank, 0, "complete");
    // A later run enriched all of them.
    await publish(enriched, 10, "partial");
    // A run that re-found nothing, because collection skips hydrated fights.
    await publish([], 20, "partial");

    const stored = await repositories.evidence.getCompleted(rootKey);
    expect(stored?.kills).toHaveLength(fights);
    expect(
      stored?.kills.filter(
        (kill) => kill.performance.damage.state === "available"
      )
    ).toHaveLength(fights);
    expect(stored?.kills[0]?.performance.spec).toEqual({
      name: "Assassination",
      iconUrl:
        "https://wow.zamimg.com/images/wow/icons/medium/ability_rogue_deadlybrew.jpg"
    });
  });

  it("agrees with the dossier on which run is newest when two tie", async () => {
    // Break caught: `loadStoredPerformanceByFightUrl` ordered by
    // `completed_at DESC` with no tiebreak, while `loadCompletedEvidence`
    // orders by `completed_at DESC, id DESC`. On a tie the two disagreed about
    // which run was newest, so a publish could carry forward a copy of a fight
    // the dossier does not show -- the same shape as #331, where a tie in an
    // ORDER BY left the winner to PostgreSQL's discretion and coverage
    // oscillated for a day before anyone could attribute it.
    const enriched = mythicKill({
      performance: {
        spec: null,
        damage: { state: "available", percentile: 91 },
        healing: { state: "unavailable" },
        bossDamage: { state: "unavailable" }
      }
    });
    const completedAt = new Date("2026-08-04T12:05:00.000Z");
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
      completedAt
    });

    // A second settled run sharing that completion instant, holding the same
    // fight blank. Its id sorts above the first, so the dossier's
    // `id DESC` tiebreak prefers it -- and a loader without that tiebreak is
    // free to prefer the other one.
    const tied = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await pool.query(
      `INSERT INTO character_evidence_runs
         (id, region, realm_slug, normalized_name, status, attempt,
          evidence_version, created_at, completed_at)
       VALUES ($1, $2, $3, $4, 'complete', 1,
               (SELECT evidence_version FROM character_evidence_runs WHERE id = $5),
               $6, $6)`,
      [
        tied,
        rootKey.region,
        rootKey.realm,
        rootKey.name,
        first.run.id,
        completedAt
      ]
    );
    await pool.query(
      `INSERT INTO character_mythic_kills
         (evidence_run_id, source_fight_key, raid_id, raid_name, boss_id,
          boss_name, journal_boss_id, boss_order, killed_at,
          report_url, fight_url, damage_parse_state, healing_parse_state,
          boss_damage_parse_state, collected_at)
       SELECT $1, source_fight_key, raid_id, raid_name, boss_id, boss_name,
              journal_boss_id, boss_order, killed_at,
              report_url, fight_url, 'unavailable', 'unavailable',
              'unavailable', collected_at
         FROM character_mythic_kills
        WHERE evidence_run_id = $2`,
      [tied, first.run.id]
    );

    // Whatever the dossier reads is by definition the newest stored copy.
    const before = await repositories.evidence.getCompleted(rootKey);
    const expected = before?.kills[0]?.performance.damage;

    // A later run that re-found the fight without re-hydrating it. Raid 42 is
    // not terminal, so nothing is carried forward wholesale and the publish
    // has to consult the stored-performance loader.
    const later = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T13:00:00.000Z"),
      at: new Date("2026-08-04T13:00:00.000Z")
    });
    if (later.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(later.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-08-04T13:05:00.000Z")
    });

    const after = await repositories.evidence.getCompleted(rootKey);
    expect(after?.kills[0]?.performance.damage).toEqual(expected);
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
        spec: {
          name: "Assassination",
          iconUrl:
            "https://wow.zamimg.com/images/wow/icons/medium/ability_rogue_deadlybrew.jpg"
        },
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

  it("reopens stored parse metrics that have no specialization data", async () => {
    // Break caught: the parse-tier version bump reopens the tier, but the
    // per-fight hydration list could still skip its old spec-less row before
    // Warcraft Logs had a chance to supply the missing specialization.
    const oldParse = mythicKill({
      performance: {
        spec: null,
        damage: { state: "available", percentile: 91 },
        healing: { state: "unavailable" },
        bossDamage: { state: "unavailable" }
      }
    });
    const reservation = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (reservation.kind !== "reserved") {
      throw new Error("evidence_not_reserved");
    }
    await repositories.evidence.publish(reservation.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [oldParse],
      wipes: [],
      tierBests: [],
      parsedFightUrls: [oldParse.fightUrl],
      completedAt: new Date("2026-08-04T12:05:00.000Z")
    });

    await expect(
      repositories.evidence.hydratedFightUrls(
        rootKey,
        new Date("2026-09-18T00:00:00.000Z")
      )
    ).resolves.toEqual([]);
  });

  it("recollects an old terminal parse through the bounded collection path", async () => {
    // Break caught: the parse-tier version bump is only useful when it reaches
    // the request selector. A spec-less row must be fetched again, persisted
    // with the new specialization, and must not reopen kills or tier bests.
    const oldParse = mythicKill({
      performance: {
        spec: null,
        damage: { state: "available", percentile: 91 },
        healing: { state: "unavailable" },
        bossDamage: { state: "unavailable" }
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
      kills: [oldParse],
      wipes: [],
      tierBests: [],
      parsedFightUrls: [oldParse.fightUrl],
      completedAt: new Date("2026-08-04T12:05:00.000Z")
    });
    await pool.query(
      `INSERT INTO character_terminal_tiers
         (region, realm_slug, normalized_name, raid_id, domain, collection_version)
       VALUES ($1, $2, $3, $4, 'parses', 1),
              ($1, $2, $3, $4, 'kills', 2),
              ($1, $2, $3, $4, 'tier_bests', 1)`,
      [rootKey.region, rootKey.realm, rootKey.name, oldParse.raidId]
    );
    const next = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T13:00:00.000Z"),
      at: new Date("2026-08-04T13:00:00.000Z")
    });
    if (next.kind !== "reserved") throw new Error("evidence_not_reserved");

    const refreshed = mythicKill({
      performance: {
        spec: {
          name: "Assassination",
          iconUrl:
            "https://wow.zamimg.com/images/wow/icons/medium/ability_rogue_deadlybrew.jpg"
        },
        damage: { state: "available", percentile: 91 },
        healing: { state: "unavailable" },
        bossDamage: { state: "unavailable" }
      }
    });
    const getFirstKillReports = async (
      _key: typeof rootKey,
      options: {
        hydratedFightUrls?: ReadonlySet<string>;
        terminalRaidIds?: {
          kills: ReadonlySet<string>;
          parses: ReadonlySet<string>;
          tierBests: ReadonlySet<string>;
        };
      }
    ) => {
      expect(options.hydratedFightUrls).not.toContain(oldParse.fightUrl);
      expect(options.terminalRaidIds).toEqual({
        kills: new Set([oldParse.raidId]),
        parses: new Set(),
        tierBests: new Set([oldParse.raidId])
      });
      return {
        kind: "evidence" as const,
        parsedFightUrls: [refreshed.fightUrl],
        kills: [refreshed],
        wipes: [],
        tierBests: [],
        troubledRaidIds: { parses: [], tierBests: [] }
      };
    };
    const handler = createApplicantEvidenceJobHandler({
      evidence: repositories.evidence,
      warcraftLogs: {
        getRateLimit: async () => ({
          kind: "rate_limit" as const,
          limitPerHour: 18_000,
          pointsSpentThisHour: 0,
          pointsResetInSeconds: 949
        }),
        getFirstKillReports
      } as unknown as Pick<
        WarcraftLogsGateway,
        "getRateLimit" | "getFirstKillReports"
      >,
      requestCap: 500,
      parseRequestCap: 24,
      capRetryMs: 1_800_000,
      transientRetryMs: 900_000,
      pointsReserve: 0,
      retryCostCeiling: 250,
      failureCooldownMs: 1_800_000,
      killSettleMs: 7 * 24 * 60 * 60 * 1000,
      now: () => new Date("2026-09-18T12:00:00.000Z")
    });

    await handler.execute(next.run.id);

    await expect(
      repositories.evidence.getCompleted(rootKey)
    ).resolves.toMatchObject({
      kills: [
        {
          performance: {
            spec: { name: "Assassination" }
          }
        }
      ]
    });
  });

  it("reports a fight asked about and answered with nothing as needing nothing further", async () => {
    // Half of hydrated fights come back with no ranking at all. Stored as
    // three `unavailable` metrics they are indistinguishable from a fight
    // never requested, so every run re-read them -- and the hydration order
    // sorts exactly those to the front (#297).
    const answered = mythicKill({
      fightUrl: "https://www.warcraftlogs.com/reports/example#fight=answered"
    });
    const unasked = mythicKill({
      fightUrl: "https://www.warcraftlogs.com/reports/example#fight=unasked"
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
      kills: [answered, unasked],
      wipes: [],
      tierBests: [],
      parsedFightUrls: [answered.fightUrl],
      completedAt: new Date("2026-08-04T12:05:00.000Z")
    });

    // Neither carries a percentile; only one has been asked about.
    await expect(
      repositories.evidence.hydratedFightUrls(
        rootKey,
        new Date("2026-09-18T00:00:00.000Z")
      )
    ).resolves.toEqual([answered.fightUrl]);
  });

  it("keeps a fight's read time when a later run skips it", async () => {
    // Collection skips a fight precisely because it has already been
    // answered, so a publish that restamped every kill would claim the run
    // re-read what it deliberately did not fetch.
    const answered = mythicKill({
      fightUrl: "https://www.warcraftlogs.com/reports/example#fight=answered"
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
      kills: [answered],
      wipes: [],
      tierBests: [],
      parsedFightUrls: [answered.fightUrl],
      completedAt: new Date("2026-08-04T12:05:00.000Z")
    });

    const second = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-05T11:00:00.000Z"),
      at: new Date("2026-08-05T12:00:00.000Z")
    });
    if (second.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(second.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [answered],
      wipes: [],
      tierBests: [],
      // The run found the fight again and skipped asking about it.
      parsedFightUrls: [],
      completedAt: new Date("2026-08-05T12:05:00.000Z")
    });

    const stored = await repositories.evidence.getCompleted(rootKey);
    expect(stored?.kills[0]?.parsesReadAt).toBe("2026-08-04T12:05:00.000Z");
    await expect(
      repositories.evidence.hydratedFightUrls(
        rootKey,
        new Date("2026-09-18T00:00:00.000Z")
      )
    ).resolves.toEqual([answered.fightUrl]);
  });

  it("keeps a staged collection until its publication stores it", async () => {
    // Break caught: the stage is what stops a transient publication failure
    // from costing a second full collection (#292). A stage that outlived its
    // publication would be republished over evidence already stored.
    const reservation = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (reservation.kind !== "reserved")
      throw new Error("evidence_not_reserved");
    const staged = {
      state: "partial" as const,
      limitationCode: null,
      parseLimitationCode: "parse_request_cap",
      retryAfterAt: "2026-08-04T12:35:00.000Z",
      kills: [mythicKill()],
      wipes: [],
      tierBests: [],
      completedAt: "2026-08-04T12:05:00.000Z"
    };

    await repositories.evidence.stageCollection(reservation.run.id, staged);
    await expect(
      repositories.evidence.stagedCollection(reservation.run.id)
    ).resolves.toEqual(staged);

    await repositories.evidence.publish(reservation.run.id, {
      state: "partial",
      limitationCode: null,
      parseLimitationCode: "parse_request_cap",
      kills: staged.kills,
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-08-04T12:05:00.000Z")
    });

    await expect(
      repositories.evidence.stagedCollection(reservation.run.id)
    ).resolves.toBeNull();
  });

  it("drops a stage whose run never reached a publication", async () => {
    // Break caught: a run whose job died between staging and publishing leaves
    // a copy of its evidence behind. Nothing will republish it once the run has
    // settled, so the hourly cleanup is what keeps it from accumulating.
    const reservation = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (reservation.kind !== "reserved")
      throw new Error("evidence_not_reserved");
    await repositories.evidence.stageCollection(reservation.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      retryAfterAt: null,
      kills: [],
      wipes: [],
      tierBests: [],
      completedAt: "2026-08-04T12:05:00.000Z"
    });

    // Still active: the attempt may yet publish it.
    await expect(
      repositories.evidence.clearSettledCollectionStages()
    ).resolves.toBe(0);

    await repositories.evidence.fail(reservation.run.id, "collection_failed");

    await expect(
      repositories.evidence.clearSettledCollectionStages()
    ).resolves.toBe(1);
    await expect(
      repositories.evidence.stagedCollection(reservation.run.id)
    ).resolves.toBeNull();
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
      evidenceVersion: 15,
      kills: [
        expect.objectContaining({ bossId: "1234", bossOrder: 8 }),
        expect.objectContaining({ bossId: "1235", bossOrder: 7 })
      ],
      wipes: [expect.objectContaining({ bossId: "1233", bossOrder: 6 })],
      tierBests: [],
      cuttingEdges: [],
      cuttingEdgesCollected: false,
      wipeCapable: true
    });
  });

  it("lists every evidence run through an operator-safe monitor projection", async () => {
    // Break caught: the monitor must distinguish all six persisted states
    // without returning queue identifiers or encrypted visitor credentials.
    await pool.query(
      `INSERT INTO character_evidence_runs
         (region, realm_slug, normalized_name, status, evidence_version,
          attempt, limitation_code, parse_limitation_code, retry_after_at,
          error_code, created_at, started_at, completed_at,
          wcl_client_id_encrypted, wcl_client_secret_encrypted)
       VALUES
         ('eu', 'silvermoon', 'queued', 'queued', 13, 0, NULL, NULL, NULL,
          NULL, '2026-09-20T09:00:00Z', NULL, NULL, 'client-cipher', 'secret-cipher'),
         ('eu', 'silvermoon', 'running', 'running', 13, 1, NULL, NULL, NULL,
          NULL, '2026-09-20T09:30:00Z', '2026-09-20T10:00:00Z', NULL, NULL, NULL),
         ('eu', 'silvermoon', 'retrying', 'retrying', 13, 2, 'rate_limited', NULL,
          '2026-09-20T12:15:00Z', NULL, '2026-09-20T09:45:00Z',
          '2026-09-20T10:30:00Z', NULL, NULL, NULL),
         ('eu', 'silvermoon', 'complete', 'complete', 12, 1, NULL, NULL, NULL,
          NULL, '2026-09-20T07:00:00Z', '2026-09-20T07:05:00Z',
          '2026-09-20T08:00:00Z', NULL, NULL),
         ('eu', 'silvermoon', 'partial', 'partial', 13, 1, 'request_cap',
          'parse_request_cap', NULL, NULL, '2026-09-20T08:00:00Z',
          '2026-09-20T08:05:00Z', '2026-09-20T09:00:00Z', NULL, NULL),
         ('eu', 'silvermoon', 'failed', 'failed', 13, 3, NULL, NULL, NULL,
          'warcraft_logs_unavailable', '2026-09-20T06:00:00Z',
          '2026-09-20T06:05:00Z', '2026-09-20T07:00:00Z', NULL, NULL)`
    );

    const rows = await repositories.evidence.listForMonitor();

    expect(rows.map((row) => row.status)).toEqual([
      "queued",
      "running",
      "retrying",
      "partial",
      "complete",
      "failed"
    ]);
    expect(rows).toContainEqual({
      key: { region: "eu", realm: "silvermoon", name: "partial" },
      status: "partial",
      evidenceVersion: 13,
      attempt: 1,
      limitationCode: "request_cap",
      parseLimitationCode: "parse_request_cap",
      retryAfterAt: null,
      errorCode: null,
      startedAt: new Date("2026-09-20T08:05:00Z"),
      completedAt: new Date("2026-09-20T09:00:00Z")
    });
    expect(JSON.stringify(rows)).not.toContain("cipher");
    expect(rows.every((row) => !("id" in row) && !("queueJobId" in row))).toBe(
      true
    );
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

  it("drains a stored Mythic dungeon kill through a partial publish", async () => {
    // Break caught: a partial publish carries every stored row forward, and a
    // veteran that exhausts its parse budget publishes partial on every run --
    // so stored dungeon kills would never age out on their own, and the floor
    // they pinned would stay pinned long after collection stopped producing
    // them (#346).
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "dungeondrain"
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
        mythicKill({ raidId: "42" }),
        mythicKill({
          raidId: "2290",
          raidName: "Mists of Tirna Scithe",
          bossId: "2419",
          bossName: "Ingra Maloch",
          fightUrl: "https://www.warcraftlogs.com/reports/dungeon#fight=1"
        })
      ],
      wipes: []
    });

    const second = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date("2026-09-19T00:00:00.000Z"),
      at: new Date("2026-09-19T00:00:00.000Z")
    });
    // Partial: the publish that carries everything forward, which is the one
    // that used to keep the dungeon alive.
    await repositories.evidence.publish(second.run.id, {
      state: "partial",
      limitationCode: null,
      parseLimitationCode: "parse_request_cap",
      tierBests: [],
      completedAt: new Date("2026-09-19T00:00:00.000Z"),
      kills: [],
      wipes: []
    });

    await expect(
      repositories.evidence
        .getCompleted(key)
        .then((completed) => completed?.kills.map((kill) => kill.raidId))
    ).resolves.toEqual(["42"]);
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

  it("reports stored wipes alongside stored kills for the scan floor", async () => {
    // Break caught: #326. The floor is what decides how far back the scan
    // pages, and a complete publish drops a stored wipe on the same condition
    // it drops a stored kill. A loader that handed over kills alone let the
    // floor rise above a raid the character has only ever wiped in -- a raid
    // that can never be marked terminal, because it has no kill to settle.
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "floorevidence"
    } as const;
    const at = new Date("2026-09-18T00:00:00.000Z");
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
      kills: [
        mythicKill({ raidId: "42", killedAt: "2026-08-04T12:00:00.000Z" })
      ],
      wipes: [
        mythicWipe({ raidId: "43", attemptedAt: "2026-03-01T11:00:00.000Z" })
      ]
    });

    await expect(
      repositories.evidence.storedEvidenceTiers(key)
    ).resolves.toEqual(
      expect.objectContaining({
        kills: [
          expect.objectContaining({
            raidId: "42",
            killedAt: "2026-08-04T12:00:00.000Z"
          })
        ],
        wipes: [
          {
            raidId: "43",
            raidName: "Nerub-ar Palace",
            attemptedAt: "2026-03-01T11:00:00.000Z"
          }
        ]
      })
    );
  });

  it("reports parse work only when the newest completed run left it outstanding", async () => {
    // Break caught: a clean-scan timestamp by itself made every fresh run
    // parse-only, including a manual refresh after a fully complete run. The
    // repository must carry the newest run's reason alongside scan freshness.
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "parsework"
    } as const;
    const firstAt = new Date("2026-09-19T10:00:00.000Z");
    const first = await repositories.evidence.reserve({
      key,
      freshnessCutoff: firstAt,
      at: firstAt
    });
    await repositories.evidence.publish(first.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [],
      tierBests: [],
      completedAt: firstAt
    });
    await expect(
      repositories.evidence.storedEvidenceTiers(key)
    ).resolves.toMatchObject({ parseWorkOutstanding: false });

    const secondAt = new Date("2026-09-19T10:30:00.000Z");
    const second = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date("2026-09-19T10:00:01.000Z"),
      at: secondAt
    });
    await repositories.evidence.publish(second.run.id, {
      state: "partial",
      limitationCode: null,
      parseLimitationCode: "parse_request_cap",
      kills: [],
      wipes: [],
      tierBests: [],
      completedAt: secondAt
    });
    await expect(
      repositories.evidence.storedEvidenceTiers(key)
    ).resolves.toMatchObject({ parseWorkOutstanding: true });

    const thirdAt = new Date("2026-09-19T11:00:00.000Z");
    const third = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date("2026-09-19T10:30:01.000Z"),
      at: thirdAt
    });
    await repositories.evidence.publish(third.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [],
      tierBests: [],
      completedAt: thirdAt
    });
    await expect(
      repositories.evidence.storedEvidenceTiers(key)
    ).resolves.toMatchObject({ parseWorkOutstanding: false });
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

  it("reopens only terminal parse tiers recorded before the specialization refresh", async () => {
    // Break caught: bumping the global evidence version would unbound every
    // settled tier, while leaving parses at version 1 would keep their old
    // specialization-free rows permanently out of collection.
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "domainbump"
    } as const;
    await pool.query(
      `INSERT INTO character_terminal_tiers
         (region, realm_slug, normalized_name, raid_id, domain, collection_version)
       VALUES ($1, $2, $3, '42', 'parses', 1),
              ($1, $2, $3, '42', 'kills', 2),
              ($1, $2, $3, '42', 'tier_bests', 1)`,
      [key.region, key.realm, key.name]
    );

    await expect(repositories.evidence.terminalTiers(key)).resolves.toEqual([
      { raidId: "42", domain: "kills" },
      { raidId: "42", domain: "tier_bests" }
    ]);
  });

  it("reopens terminal kill tiers recorded before guild-attendance recovery", async () => {
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "guildattendancebump"
    } as const;
    await pool.query(
      `INSERT INTO character_terminal_tiers
         (region, realm_slug, normalized_name, raid_id, domain, collection_version)
       VALUES ($1, $2, $3, '23', 'kills', 1)`,
      [key.region, key.realm, key.name]
    );

    await expect(repositories.evidence.terminalTiers(key)).resolves.toEqual([]);
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

  it("records every parse limitation a run raised, not only the one it is judged by", async () => {
    // Break caught: a run can raise several and the record holds one, so the
    // rest were discarded by whichever assignment ran last. That is how an
    // unmatched ranking identity hid behind `parse_request_cap` for weeks
    // (#349). The judged code still drives retry; the others are kept so a
    // masked failure is still visible afterwards.
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "parselimitations"
    } as const;
    const reserved = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date("2026-09-19T00:00:00.000Z"),
      at: new Date("2026-09-19T00:00:00.000Z")
    });
    await repositories.evidence.publish(reserved.run.id, {
      state: "partial",
      limitationCode: null,
      parseLimitationCode: "parse_request_cap",
      parseLimitationCodesSeen: [
        "parse_identity_unmatched",
        "parse_request_cap"
      ],
      kills: [],
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-09-19T00:00:00.000Z")
    });

    await expect(
      pool
        .query<{ parse_limitation_codes_seen: string[] | null }>(
          `SELECT parse_limitation_codes_seen
             FROM character_evidence_runs
            WHERE id = $1`,
          [reserved.run.id]
        )
        .then((result) => result.rows[0]?.parse_limitation_codes_seen)
    ).resolves.toEqual(["parse_identity_unmatched", "parse_request_cap"]);
  });

  it("records an empty list for a run that raised no parse limitation", async () => {
    // Empty is not null: "raised none" and "written before the column
    // existed" are different facts and must stay distinguishable.
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "noparselimitation"
    } as const;
    const reserved = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date("2026-09-19T00:00:00.000Z"),
      at: new Date("2026-09-19T00:00:00.000Z")
    });
    await repositories.evidence.publish(reserved.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      parseLimitationCodesSeen: [],
      kills: [],
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-09-19T00:00:00.000Z")
    });

    await expect(
      pool
        .query<{ parse_limitation_codes_seen: string[] | null }>(
          `SELECT parse_limitation_codes_seen
             FROM character_evidence_runs
            WHERE id = $1`,
          [reserved.run.id]
        )
        .then((result) => result.rows[0]?.parse_limitation_codes_seen)
    ).resolves.toEqual([]);
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
      },
      // A parse-only resume whose work fitted inside its budget. It skipped
      // the history scan deliberately, so it is partial with nothing to name
      // in either code -- and rejecting that shape failed every run a
      // nearly-finished character made, which is exactly when there is no cap
      // left to hit (#367). The scan it did not do is the shortfall.
      {
        state: "partial" as const,
        limitationCode: null,
        parseLimitationCode: null,
        scanSkipped: true
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
      // Partial with no shortfall of any kind: the state says the run fell
      // short and nothing says of what, which is the ambiguity the invariant
      // exists to reject. A scan the run chose to skip would answer it, so
      // this case is only invalid while `scanSkipped` is absent.
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

    // Back to the shape that was published: the identifier and the read time
    // are storage's own, and neither was part of the input.
    const asPublished = (
      kills: readonly { id: string; parsesReadAt: string | null }[]
    ) =>
      kills.map((kill) => {
        const { id, parsesReadAt, ...rest } = kill;
        void id;
        void parsesReadAt;
        return rest;
      });
    await expect(
      repositories.evidence.getCompleted(rootKey)
    ).resolves.toMatchObject({
      run: { id: initial.run.id },
      kills: initialKills
    });
    expect(
      asPublished((await repositories.evidence.getCompleted(rootKey))!.kills)
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
    expect(asPublished(completed!.kills)).toEqual(replacementKills);
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

  describe("resumable evidence", () => {
    // What a background sweep drives. Before it existed, `reserve` was reached
    // only from a dossier read, so a run that deferred itself resumed only if
    // somebody happened to load the page.
    const at = new Date("2026-09-18T13:08:00.000Z");

    async function publishWaiting(
      key: CharacterKey,
      retryAfterAt: Date | null,
      completedAt = new Date("2026-09-18T12:14:00.000Z")
    ): Promise<string> {
      // Reserved as of its own completion, so an earlier run of the same
      // character is never still fresh and this always gets a new run.
      const reservation = await repositories.evidence.reserve({
        key,
        freshnessCutoff: completedAt,
        at: completedAt
      });
      if (reservation.kind !== "reserved") {
        throw new Error("evidence_not_reserved");
      }
      await repositories.evidence.publish(reservation.run.id, {
        state: "partial",
        limitationCode: "parse_request_cap",
        parseLimitationCode: null,
        retryAfterAt,
        kills: [],
        wipes: [],
        tierBests: [],
        completedAt
      });
      return reservation.run.id;
    }

    it("returns a character whose retry deadline has passed", async () => {
      await publishWaiting(rootKey, new Date("2026-09-18T12:40:00.000Z"));

      await expect(
        repositories.evidence.listResumable(25, at)
      ).resolves.toEqual([rootKey]);
    });

    it("leaves a character whose deadline has not arrived", async () => {
      await publishWaiting(rootKey, new Date("2026-09-18T13:40:00.000Z"));

      await expect(
        repositories.evidence.listResumable(25, at)
      ).resolves.toEqual([]);
    });

    it("leaves a character with no retry deadline at all", async () => {
      // A limitation classified terminal-for-now. It is recovered by a rebuild,
      // not by a sweep, and a sweep that took it would retry a character with
      // no public logs forever.
      await publishWaiting(rootKey, null);

      await expect(
        repositories.evidence.listResumable(25, at)
      ).resolves.toEqual([]);
    });

    it("leaves a character already being collected", async () => {
      await publishWaiting(rootKey, new Date("2026-09-18T12:40:00.000Z"));
      // A reader got there first, which leaves a run queued for this character.
      const active = await repositories.evidence.reserve({
        key: rootKey,
        freshnessCutoff: new Date("2026-09-18T13:00:00.000Z"),
        at
      });
      expect(active.kind).toBe("reserved");

      await expect(
        repositories.evidence.listResumable(25, at)
      ).resolves.toEqual([]);
    });

    it("judges a character by its newest completed run only", async () => {
      // Break caught: reading every completed run rather than the latest would
      // resurrect a deadline a later, cleaner run had already superseded.
      await publishWaiting(
        rootKey,
        new Date("2026-09-18T12:40:00.000Z"),
        new Date("2026-09-18T12:14:00.000Z")
      );
      await publishWaiting(rootKey, null, new Date("2026-09-18T12:50:00.000Z"));

      await expect(
        repositories.evidence.listResumable(25, at)
      ).resolves.toEqual([]);
    });

    it("returns the longest-waiting characters first, up to the limit", async () => {
      await publishWaiting(altKey, new Date("2026-09-18T12:50:00.000Z"));
      await publishWaiting(rootKey, new Date("2026-09-18T12:40:00.000Z"));

      await expect(
        repositories.evidence.listResumable(25, at)
      ).resolves.toEqual([rootKey, altKey]);
      await expect(repositories.evidence.listResumable(1, at)).resolves.toEqual(
        [rootKey]
      );
    });
  });

  describe("abandoned evidence runs", () => {
    // What recovery reads and writes. A run whose worker dies between `claim`
    // and `publish`/`fail` stays active forever, and `reserve` then joins
    // every later read to a run that is running nowhere.
    async function reserveRun(key: CharacterKey, at: Date): Promise<string> {
      const reservation = await repositories.evidence.reserve({
        key,
        freshnessCutoff: at,
        at
      });
      if (reservation.kind !== "reserved") {
        throw new Error("evidence_not_reserved");
      }
      return reservation.run.id;
    }

    it("lists an active run with the job id and claim time recovery needs", async () => {
      const at = new Date("2026-09-18T13:25:00.000Z");
      const runId = await reserveRun(rootKey, at);
      await repositories.evidence.markEnqueued(runId, "job-1");
      await repositories.evidence.claim(runId, 1);

      const active = await repositories.evidence.listActive(25);

      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ runId, queueJobId: "job-1" });
      expect(active[0]?.startedAt).toBeInstanceOf(Date);
      expect(active[0]?.createdAt).toBeInstanceOf(Date);
    });

    it("lists a reserved run that has not been enqueued yet, with no job id", async () => {
      // The run recovery must never ask the queue about: `reserve` inserts the
      // row before `enqueue` returns an id.
      const runId = await reserveRun(
        rootKey,
        new Date("2026-09-18T13:25:00.000Z")
      );

      const active = await repositories.evidence.listActive(25);

      expect(active).toEqual([
        expect.objectContaining({ runId, queueJobId: null, startedAt: null })
      ]);
    });

    it("omits a run that has already settled", async () => {
      const runId = await reserveRun(
        rootKey,
        new Date("2026-09-18T13:25:00.000Z")
      );
      await repositories.evidence.fail(runId, "collection_failed");

      await expect(repositories.evidence.listActive(25)).resolves.toEqual([]);
    });

    it("returns the oldest active runs first, up to the limit", async () => {
      const rootRunId = await reserveRun(
        rootKey,
        new Date("2026-09-18T13:00:00.000Z")
      );
      await reserveRun(altKey, new Date("2026-09-18T13:10:00.000Z"));

      const limited = await repositories.evidence.listActive(1);

      expect(limited).toEqual([expect.objectContaining({ runId: rootRunId })]);
    });

    it("releases an abandoned run so the character can be collected again", async () => {
      const at = new Date("2026-09-18T13:25:00.000Z");
      const runId = await reserveRun(rootKey, at);
      await repositories.evidence.claim(runId, 1);

      const released = await repositories.evidence.releaseAbandoned([runId]);

      expect(released).toBe(1);
      const run = await repositories.evidence.find(runId);
      expect(run).toMatchObject({ status: "failed", errorCode: "abandoned" });
      expect(run?.completedAt).not.toBeNull();
      // `failed` is in neither the active set nor `loadCompletedEvidence`, so
      // the next read reserves a fresh run rather than joining a dead one.
      await expect(repositories.evidence.listActive(25)).resolves.toEqual([]);
      const next = await repositories.evidence.reserve({
        key: rootKey,
        freshnessCutoff: new Date("2026-09-18T13:30:00.000Z"),
        at: new Date("2026-09-18T13:30:00.000Z")
      });
      expect(next.kind).toBe("reserved");
    });

    it("clears the credentials of a run it releases", async () => {
      // `publish` and `fail` clear these on every normal path; a released run
      // must not leave a visitor's ciphertext behind either.
      const at = new Date("2026-09-18T13:25:00.000Z");
      const reservation = await repositories.evidence.reserve({
        key: rootKey,
        freshnessCutoff: at,
        at,
        credentials: {
          wclClientIdEncrypted: "cipher-id",
          wclClientSecretEncrypted: "cipher-secret"
        }
      });
      if (reservation.kind !== "reserved") {
        throw new Error("evidence_not_reserved");
      }

      await repositories.evidence.releaseAbandoned([reservation.run.id]);

      const run = await repositories.evidence.find(reservation.run.id);
      expect(run?.wclClientIdEncrypted ?? null).toBeNull();
      expect(run?.wclClientSecretEncrypted ?? null).toBeNull();
    });

    it("leaves a run that settled between the read and the write", async () => {
      // Break caught: releasing unconditionally would overwrite a publication
      // that landed while the sweep was deciding, losing collected evidence.
      const at = new Date("2026-09-18T13:25:00.000Z");
      const runId = await reserveRun(rootKey, at);
      await repositories.evidence.claim(runId, 1);
      await repositories.evidence.publish(runId, {
        state: "complete",
        limitationCode: null,
        parseLimitationCode: null,
        kills: [],
        wipes: [],
        tierBests: [],
        completedAt: at
      });

      const released = await repositories.evidence.releaseAbandoned([runId]);

      expect(released).toBe(0);
      await expect(repositories.evidence.find(runId)).resolves.toMatchObject({
        status: "complete"
      });
    });

    it("releases nothing when asked for nothing", async () => {
      await expect(repositories.evidence.releaseAbandoned([])).resolves.toBe(0);
    });

    it("rejects a scan limit outside the bounds it can serve", async () => {
      // The sweep's limit is configuration, and a value this rejects but the
      // caller accepts would throw on every tick rather than at boot.
      await expect(repositories.evidence.listActive(0)).rejects.toThrow(
        "character_evidence_active_limit_out_of_range"
      );
      await expect(repositories.evidence.listActive(1_001)).rejects.toThrow(
        "character_evidence_active_limit_out_of_range"
      );
    });

    it("drops the staged collection of a run it releases", async () => {
      // The repository contract, which the sweep above no longer exercises:
      // recovery republishes a stage rather than releasing the run that holds
      // one. This remains the guarantee for a stage that is released by some
      // other route -- once the run has settled, the stage belongs to an
      // attempt nothing will republish, and the cleanup removes it rather than
      // leaving it to outlive its run.
      const at = new Date("2026-09-18T13:25:00.000Z");
      const runId = await reserveRun(rootKey, at);
      await repositories.evidence.claim(runId, 1);
      await repositories.evidence.stageCollection(runId, {
        state: "complete",
        limitationCode: null,
        parseLimitationCode: null,
        retryAfterAt: null,
        kills: [],
        wipes: [],
        tierBests: [],
        completedAt: at.toISOString()
      });

      await repositories.evidence.releaseAbandoned([runId]);

      await expect(
        repositories.evidence.clearSettledCollectionStages()
      ).resolves.toBe(1);
      await expect(
        repositories.evidence.stagedCollection(runId)
      ).resolves.toBeNull();
    });

    it("returns a character to the resume sweep when its previous run left a deadline", async () => {
      // The two halves meeting: while the run sat abandoned, `listResumable`
      // excluded this character through its active guard, so the sweep that
      // exists to drive waiting runs was the one thing that could not reach
      // it. Releasing the run is what puts it back in the sweep's population.
      const publishedAt = new Date("2026-09-18T12:14:00.000Z");
      const first = await reserveRun(rootKey, publishedAt);
      await repositories.evidence.publish(first, {
        state: "partial",
        limitationCode: "parse_request_cap",
        parseLimitationCode: null,
        retryAfterAt: new Date("2026-09-18T12:40:00.000Z"),
        kills: [],
        wipes: [],
        tierBests: [],
        completedAt: publishedAt
      });
      const at = new Date("2026-09-18T13:08:00.000Z");
      const abandoned = await reserveRun(rootKey, at);
      await repositories.evidence.claim(abandoned, 1);
      await expect(
        repositories.evidence.listResumable(25, at)
      ).resolves.toEqual([]);

      await repositories.evidence.releaseAbandoned([abandoned]);

      await expect(
        repositories.evidence.listResumable(25, at)
      ).resolves.toEqual([rootKey]);
    });

    it("leaves a released character to the next reader when its previous run is settled", async () => {
      // The limit of what recovery claims. A previous run that finished
      // cleanly carries no deadline, so nothing schedules this character: it
      // is unblocked, not back in circulation, and a dossier read is what
      // starts it collecting again.
      const publishedAt = new Date("2026-09-18T12:14:00.000Z");
      const first = await reserveRun(rootKey, publishedAt);
      await repositories.evidence.publish(first, {
        state: "complete",
        limitationCode: null,
        parseLimitationCode: null,
        kills: [],
        wipes: [],
        tierBests: [],
        completedAt: publishedAt
      });
      const at = new Date("2026-09-18T13:08:00.000Z");
      const abandoned = await reserveRun(rootKey, at);
      await repositories.evidence.claim(abandoned, 1);

      await repositories.evidence.releaseAbandoned([abandoned]);

      await expect(
        repositories.evidence.listResumable(25, at)
      ).resolves.toEqual([]);
      const next = await repositories.evidence.reserve({
        key: rootKey,
        freshnessCutoff: at,
        at
      });
      expect(next.kind).toBe("reserved");
    });

    it("lists the character key a republished run needs to settle its tiers", async () => {
      // `markTerminalTiers` is keyed by character, not by run, so recovery
      // cannot settle what it republishes without this. It goes no further
      // than that: the sweep's own record carries counts alone.
      const runId = await reserveRun(
        rootKey,
        new Date("2026-09-18T13:25:00.000Z")
      );

      const active = await repositories.evidence.listActive(25);

      expect(active).toEqual([
        expect.objectContaining({ runId, key: rootKey })
      ]);
    });

    it("completes an abandoned run from its staged scan rather than releasing it", async () => {
      // The whole of #312, end to end against real rows: a worker died between
      // `stageCollection` and `publish`, so the run holds a finished Warcraft
      // Logs scan -- 68-86% of what the run cost. Recovery publishes it
      // instead of throwing it away.
      const at = new Date("2026-09-18T13:25:00.000Z");
      const runId = await reserveRun(rootKey, at);
      await repositories.evidence.markEnqueued(runId, "job-staged");
      await repositories.evidence.claim(runId, 1);
      const kill = mythicKill({
        // Closed 2026-08-19, and killed long enough ago to have settled, so
        // this tier is eligible to go terminal.
        raidName: "The Dreamrift",
        killedAt: "2026-06-01T20:00:00.000Z"
      });
      await repositories.evidence.stageCollection(runId, {
        state: "complete",
        limitationCode: null,
        parseLimitationCode: null,
        retryAfterAt: null,
        kills: [kill],
        wipes: [],
        tierBests: [],
        completedAt: at.toISOString(),
        troubledRaidIds: { parses: [kill.raidId], tierBests: [] }
      });

      const recovered = await recoverAbandonedEvidenceRuns(
        repositories.evidence,
        {
          async settledEvidenceJobIds(jobIds) {
            return jobIds;
          }
        },
        {
          startedBefore: new Date("2026-09-18T06:00:00.000Z"),
          reservedBefore: new Date("2026-09-18T13:10:00.000Z"),
          settleMs: 7 * 24 * 60 * 60 * 1000,
          limit: 25
        }
      );

      expect(recovered).toEqual({ released: 0, republished: 1 });
      const run = await repositories.evidence.find(runId);
      expect(run).toMatchObject({ status: "complete", errorCode: null });
      // The evidence is readable, which is the point: the character is not
      // merely unblocked, it has the scan it paid for.
      const completed = await repositories.evidence.getCompleted(rootKey);
      expect(completed?.kills.map((k) => k.fightUrl)).toEqual([kill.fightUrl]);
      // `publish` deletes the stage in its own transaction.
      await expect(
        repositories.evidence.stagedCollection(runId)
      ).resolves.toBeNull();
      // Settled exactly as the run that collected it would have: parses stay
      // re-queryable because that raid was troubled in that domain.
      await expect(
        repositories.evidence.terminalTiers(rootKey)
      ).resolves.toEqual([
        { raidId: kill.raidId, domain: "kills" },
        { raidId: kill.raidId, domain: "tier_bests" }
      ]);
      // And it is out of the active set, so the next read is not stuck behind
      // a run that is running nowhere.
      await expect(repositories.evidence.listActive(25)).resolves.toEqual([]);
    });

    it("settles nothing for a stage written before trouble sets were carried", async () => {
      // Absent is not empty. A stage from before the field existed cannot say
      // which raids it had trouble with, so it publishes and marks nothing --
      // reading its silence as "none" would freeze the parse gaps that trouble
      // exists to hold open.
      const at = new Date("2026-09-18T13:25:00.000Z");
      const runId = await reserveRun(rootKey, at);
      await repositories.evidence.markEnqueued(runId, "job-old-stage");
      await repositories.evidence.claim(runId, 1);
      const kill = mythicKill({
        raidName: "The Dreamrift",
        killedAt: "2026-06-01T20:00:00.000Z"
      });
      await repositories.evidence.stageCollection(runId, {
        state: "complete",
        limitationCode: null,
        parseLimitationCode: null,
        retryAfterAt: null,
        kills: [kill],
        wipes: [],
        tierBests: [],
        completedAt: at.toISOString()
      });

      const recovered = await recoverAbandonedEvidenceRuns(
        repositories.evidence,
        {
          async settledEvidenceJobIds(jobIds) {
            return jobIds;
          }
        },
        {
          startedBefore: new Date("2026-09-18T06:00:00.000Z"),
          reservedBefore: new Date("2026-09-18T13:10:00.000Z"),
          settleMs: 7 * 24 * 60 * 60 * 1000,
          limit: 25
        }
      );

      expect(recovered).toEqual({ released: 0, republished: 1 });
      await expect(
        repositories.evidence.terminalTiers(rootKey)
      ).resolves.toEqual([]);
    });

    it("releases an abandoned run that never got as far as a stage", async () => {
      // The other half, unchanged from #305: nothing was paid for, so there is
      // nothing to publish and the run is settled as `abandoned`.
      const at = new Date("2026-09-18T13:25:00.000Z");
      const runId = await reserveRun(rootKey, at);
      await repositories.evidence.markEnqueued(runId, "job-bare");
      await repositories.evidence.claim(runId, 1);

      const recovered = await recoverAbandonedEvidenceRuns(
        repositories.evidence,
        {
          async settledEvidenceJobIds(jobIds) {
            return jobIds;
          }
        },
        {
          startedBefore: new Date("2026-09-18T06:00:00.000Z"),
          reservedBefore: new Date("2026-09-18T13:10:00.000Z"),
          settleMs: 7 * 24 * 60 * 60 * 1000,
          limit: 25
        }
      );

      expect(recovered).toEqual({ released: 1, republished: 0 });
      await expect(repositories.evidence.find(runId)).resolves.toMatchObject({
        status: "failed",
        errorCode: "abandoned"
      });
    });
  });

  describe("evidence run costs", () => {
    // What a run spent, and the configuration it spent it under. Before #342
    // this existed only in the worker's deployment logs, which serve the
    // current deployment alone, so every re-derivation of the points budget
    // was an archaeology exercise nobody performed.
    async function reserveRun(key: CharacterKey, at: Date): Promise<string> {
      const reservation = await repositories.evidence.reserve({
        key,
        freshnessCutoff: at,
        at
      });
      if (reservation.kind !== "reserved") {
        throw new Error("evidence_not_reserved");
      }
      return reservation.run.id;
    }

    function cost(
      runId: string,
      overrides: Partial<EvidenceRunCost> = {}
    ): EvidenceRunCost {
      return {
        runId,
        attempt: 1,
        outcome: "published",
        credentials: "own",
        limitationCode: null,
        parseLimitationCode: null,
        pointsSpent: 760.25,
        pointsLimitPerHour: 18_000,
        pointsRemainingBefore: 17_000,
        pointsRemainingAfter: 16_239.75,
        requestCapUsed: 300,
        parseRequestCapUsed: 24,
        requests: {
          historyScan: 12,
          zoneRankings: 3,
          fightParses: 24,
          rankingIdentities: 1
        },
        ...overrides
      };
    }

    async function rows(): Promise<ReadonlyArray<Record<string, unknown>>> {
      const result = await pool.query(
        `SELECT * FROM character_evidence_run_costs
         ORDER BY recorded_at, run_id, attempt`
      );
      return result.rows as ReadonlyArray<Record<string, unknown>>;
    }

    it("records what an attempt spent, with the caps it was given", async () => {
      const runId = await reserveRun(rootKey, new Date());

      await repositories.evidence.recordRunCost(cost(runId));

      expect(await rows()).toEqual([
        expect.objectContaining({
          run_id: runId,
          attempt: 1,
          outcome: "published",
          credentials: "own",
          points_spent: 760.25,
          points_limit_per_hour: 18_000,
          points_remaining_before: 17_000,
          points_remaining_after: 16_239.75,
          request_cap_used: 300,
          parse_request_cap_used: 24,
          history_scan_requests: 12,
          zone_rankings_requests: 3,
          fight_parses_requests: 24,
          ranking_identities_requests: 1
        })
      ]);
    });

    it("keeps an unmeasured spend null rather than zero", async () => {
      // The distinction the whole table rests on: null is `unavailable` -- the
      // allowance could not be read -- and a zero is a run that genuinely
      // spent nothing. A query that averaged the two together would report a
      // cost no run ever had.
      const runId = await reserveRun(rootKey, new Date());

      await repositories.evidence.recordRunCost(
        cost(runId, {
          outcome: "unexpected_error",
          pointsSpent: null,
          pointsLimitPerHour: null,
          pointsRemainingBefore: null,
          pointsRemainingAfter: null
        })
      );

      const [row] = await rows();
      expect(row?.points_spent).toBeNull();
      expect(row?.points_remaining_before).toBeNull();
      expect(row?.points_remaining_after).toBeNull();
    });

    it("records a spend of zero as zero", async () => {
      const runId = await reserveRun(rootKey, new Date());

      await repositories.evidence.recordRunCost(
        cost(runId, { pointsSpent: 0, pointsRemainingAfter: 17_000 })
      );

      const [row] = await rows();
      expect(row?.points_spent).toBe(0);
    });

    it("keeps one row per attempt, because a retry pays for its own scan", async () => {
      const runId = await reserveRun(rootKey, new Date());

      await repositories.evidence.recordRunCost(
        cost(runId, { attempt: 1, pointsSpent: 2_523.24 })
      );
      await repositories.evidence.recordRunCost(
        cost(runId, { attempt: 2, pointsSpent: 1_180.95 })
      );

      expect((await rows()).map((row) => row.points_spent)).toEqual([
        2_523.24, 1_180.95
      ]);
    });

    it("refreshes an attempt re-entered after a crash rather than failing", async () => {
      const runId = await reserveRun(rootKey, new Date());

      await repositories.evidence.recordRunCost(
        cost(runId, { outcome: "unknown", pointsSpent: 100 })
      );
      await repositories.evidence.recordRunCost(
        cost(runId, { outcome: "published", pointsSpent: 950.5 })
      );

      expect(await rows()).toEqual([
        expect.objectContaining({ outcome: "published", points_spent: 950.5 })
      ]);
    });

    it("rejects an attempt number no run could have", async () => {
      const runId = await reserveRun(rootKey, new Date());

      await expect(
        repositories.evidence.recordRunCost(cost(runId, { attempt: 0 }))
      ).rejects.toThrow(RangeError);
    });

    it("rejects a credentials value outside the two the budget branches on", async () => {
      // The column is the scan share's input, not free text: `evidenceRunBudget`
      // branches on exactly these two, and anything narrower would put a
      // visitor identifier in a table whose stated property is that it holds
      // none.
      const runId = await reserveRun(rootKey, new Date());

      await expect(
        repositories.evidence.recordRunCost(
          cost(runId, {
            credentials: "someone" as EvidenceRunCost["credentials"]
          })
        )
      ).rejects.toThrow();
    });

    it("goes when the run it measures goes", async () => {
      const runId = await reserveRun(rootKey, new Date());
      await repositories.evidence.recordRunCost(cost(runId));

      await pool.query(`DELETE FROM character_evidence_runs WHERE id = $1`, [
        runId
      ]);

      expect(await rows()).toEqual([]);
    });

    it("drops rows older than the retention cutoff and keeps the rest", async () => {
      const oldRun = await reserveRun(rootKey, new Date());
      const freshRun = await reserveRun(altKey, new Date());
      await repositories.evidence.recordRunCost(cost(oldRun));
      await repositories.evidence.recordRunCost(cost(freshRun));
      await pool.query(
        `UPDATE character_evidence_run_costs SET recorded_at = $2
         WHERE run_id = $1`,
        [oldRun, new Date(Date.now() - 30 * 24 * 60 * 60_000)]
      );

      const removed = await repositories.evidence.clearExpiredRunCosts(
        new Date(Date.now() - 28 * 24 * 60 * 60_000)
      );

      expect(removed).toBe(1);
      expect((await rows()).map((row) => row.run_id)).toEqual([freshRun]);
    });

    describe("the documented queries", () => {
      // Run verbatim from `docs/operations/evidence-run-cost.md`. Doc drift is
      // what this repository keeps paying for -- a number set once, in one
      // file, with nothing forcing the second look -- so the document either
      // still describes these columns or the integration suite is red.
      const documented = readFileSync(
        new URL("../../docs/operations/evidence-run-cost.md", import.meta.url),
        "utf8"
      );
      const queries = [...documented.matchAll(SQL_BLOCK)].map(
        (match) => match[1] as string
      );

      it("finds exactly the two queries the document describes", () => {
        expect(queries).toHaveLength(2);
      });

      it("returns the spend distribution grouped by the caps in force", async () => {
        const cheap = await reserveRun(rootKey, new Date());
        const dear = await reserveRun(altKey, new Date());
        await repositories.evidence.recordRunCost(
          cost(cheap, {
            pointsSpent: 700,
            pointsRemainingBefore: 17_000,
            pointsRemainingAfter: 16_300,
            parseRequestCapUsed: 24
          })
        );
        await repositories.evidence.recordRunCost(
          cost(cheap, {
            attempt: 2,
            pointsSpent: 900,
            pointsRemainingBefore: 16_300,
            pointsRemainingAfter: 15_400,
            parseRequestCapUsed: 24
          })
        );
        await repositories.evidence.recordRunCost(
          cost(dear, {
            pointsSpent: 2_400,
            pointsRemainingBefore: 15_400,
            pointsRemainingAfter: 13_000,
            parseRequestCapUsed: 48
          })
        );

        const result = await pool.query(queries[0] as string);

        expect(result.rows).toEqual([
          expect.objectContaining({
            credentials: "own",
            request_cap_used: 300,
            parse_request_cap_used: 24,
            attempts: "2",
            measured: "2",
            p50: "800.00",
            max_spent: "900.00",
            window_moved: "0"
          }),
          expect.objectContaining({
            parse_request_cap_used: 48,
            attempts: "1",
            measured: "1",
            max_spent: "2400.00"
          })
        ]);
      });

      it("counts an unmeasured attempt without letting it reach the percentiles", async () => {
        const runId = await reserveRun(rootKey, new Date());
        await repositories.evidence.recordRunCost(
          cost(runId, {
            pointsSpent: 800,
            pointsRemainingBefore: 17_000,
            pointsRemainingAfter: 16_200
          })
        );
        await repositories.evidence.recordRunCost(
          cost(runId, {
            attempt: 2,
            pointsSpent: null,
            pointsLimitPerHour: null,
            pointsRemainingBefore: null,
            pointsRemainingAfter: null
          })
        );

        const result = await pool.query(queries[0] as string);

        expect(result.rows).toEqual([
          expect.objectContaining({
            attempts: "2",
            measured: "1",
            p50: "800.00"
          })
        ]);
      });

      it("flags a row whose hourly window moved under it", async () => {
        // `points_spent` is the delta of the same counter the remaining
        // readings are derived from, so the two agree by construction -- until
        // the reported limit changes between them. Then the row is measuring
        // two different hours and its spend is not a sample of anything.
        const runId = await reserveRun(rootKey, new Date());
        await repositories.evidence.recordRunCost(
          cost(runId, {
            pointsSpent: 500,
            pointsRemainingBefore: 17_000,
            pointsRemainingAfter: 17_800
          })
        );

        const result = await pool.query(queries[0] as string);

        expect(result.rows).toEqual([
          expect.objectContaining({ attempts: "1", window_moved: "1" })
        ]);
      });

      it("reads a clean serial handover as clean", async () => {
        // Break caught: this query flagged every healthy run. Reading the
        // allowance is itself a metered request, so a clean handover leaves a
        // gap of exactly one point, not zero -- twelve of twelve consecutive
        // handovers in `test` on 2026-09-19. The original threshold of 0.01
        // called all of them contaminated, which is worse than no check: it
        // invites throwing away the only samples there are.
        const first = await reserveRun(rootKey, new Date());
        const second = await reserveRun(altKey, new Date());
        await repositories.evidence.recordRunCost(
          cost(first, {
            pointsSpent: 1_000,
            pointsRemainingBefore: 17_000,
            pointsRemainingAfter: 16_000
          })
        );
        await repositories.evidence.recordRunCost(
          cost(second, {
            pointsSpent: 1_000,
            // One point below the previous run's closing reading: its own
            // opening allowance check, and nothing else.
            pointsRemainingBefore: 15_999,
            pointsRemainingAfter: 14_999
          })
        );
        await pool.query(
          `UPDATE character_evidence_run_costs SET recorded_at = $2
           WHERE run_id = $1`,
          [first, new Date(Date.now() - 60_000)]
        );

        const result = await pool.query<{
          raw_gap: string | null;
          unaccounted_spend: string | null;
        }>(queries[1] as string);

        expect(result.rows.map((row) => row.raw_gap)).toEqual([null, "1.00"]);
        expect(result.rows.map((row) => row.unaccounted_spend)).toEqual([
          null,
          "0.00"
        ]);
      });

      it("finds spend by something this table never recorded", async () => {
        // The contamination that produced three wrong numbers: a second run
        // against the same hourly counter. It inflates both of a row's own
        // readings equally, so only the gap between consecutive rows shows it.
        const first = await reserveRun(rootKey, new Date());
        const second = await reserveRun(altKey, new Date());
        await repositories.evidence.recordRunCost(
          cost(first, {
            pointsSpent: 1_000,
            pointsRemainingBefore: 17_000,
            pointsRemainingAfter: 16_000
          })
        );
        await repositories.evidence.recordRunCost(
          cost(second, {
            pointsSpent: 1_000,
            // 400 points left the counter between the two runs on top of this
            // run's own allowance check, and nothing here paid for them.
            pointsRemainingBefore: 15_599,
            pointsRemainingAfter: 14_599
          })
        );
        await pool.query(
          `UPDATE character_evidence_run_costs SET recorded_at = $2
           WHERE run_id = $1`,
          [first, new Date(Date.now() - 60_000)]
        );

        const result = await pool.query<{
          raw_gap: string | null;
          unaccounted_spend: string | null;
        }>(queries[1] as string);

        expect(result.rows.map((row) => row.raw_gap)).toEqual([null, "401.00"]);
        expect(result.rows.map((row) => row.unaccounted_spend)).toEqual([
          null,
          "400.00"
        ]);
      });

      it("does not read the hourly reset as unaccounted spend", async () => {
        const first = await reserveRun(rootKey, new Date());
        const second = await reserveRun(altKey, new Date());
        await repositories.evidence.recordRunCost(
          cost(first, {
            pointsSpent: 1_000,
            pointsRemainingBefore: 3_000,
            pointsRemainingAfter: 2_000
          })
        );
        await repositories.evidence.recordRunCost(
          cost(second, {
            pointsSpent: 1_000,
            // The window reset: the allowance refilled between the two runs.
            pointsRemainingBefore: 18_000,
            pointsRemainingAfter: 17_000
          })
        );
        await pool.query(
          `UPDATE character_evidence_run_costs SET recorded_at = $2
           WHERE run_id = $1`,
          [first, new Date(Date.now() - 60_000)]
        );

        const result = await pool.query<{
          unaccounted_spend: string | null;
        }>(queries[1] as string);

        expect(
          result.rows.every((row) => Number(row.unaccounted_spend ?? 0) <= 0.01)
        ).toBe(true);
      });

      it("leaves a visitor's own counter out of the comparison", async () => {
        // A visitor's run draws on their account, not the worker's, so its
        // readings are not comparable to the worker's or to each other's.
        const runId = await reserveRun(rootKey, new Date());
        await repositories.evidence.recordRunCost(
          cost(runId, { credentials: "visitor" })
        );

        const result = await pool.query(queries[1] as string);

        expect(result.rows).toEqual([]);
      });
    });
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
      limitationCode: "privacy_hidden",
      historicalGuilds: []
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

  it("renews only a valid operator session without extending its absolute expiry", async () => {
    // Break caught: a session lookup that verifies only the id could accept a
    // forged secret, expired session, disabled operator, or stale credential.
    const auth = repositories.operatorAuth;
    const operator = await provisionOperator();
    const sessionId = "10000000-0000-0000-0000-000000000001";
    const issuedAt = new Date("2026-09-21T12:00:00.000Z");
    const absoluteExpiresAt = new Date("2026-09-21T20:00:00.000Z");

    await auth.issueSession({
      sessionId,
      secretDigest: "hmac:valid-secret",
      operatorId: operator.id,
      credentialVersion: operator.credentialVersion,
      issuedAt,
      lastUsedAt: issuedAt,
      idleExpiresAt: new Date("2026-09-21T12:30:00.000Z"),
      absoluteExpiresAt
    });

    await expect(
      auth.useSession({
        sessionId,
        secretDigest: "hmac:valid-secret",
        at: new Date("2026-09-21T12:10:00.000Z"),
        idleExpiresAt: new Date("2026-09-21T20:30:00.000Z")
      })
    ).resolves.toMatchObject({
      operator: { id: operator.id, active: true },
      session: {
        id: sessionId,
        lastUsedAt: new Date("2026-09-21T12:10:00.000Z"),
        idleExpiresAt: absoluteExpiresAt,
        absoluteExpiresAt
      }
    });
    await expect(
      auth.useSession({
        sessionId,
        secretDigest: "hmac:wrong-secret",
        at: new Date("2026-09-21T12:11:00.000Z"),
        idleExpiresAt: new Date("2026-09-21T12:41:00.000Z")
      })
    ).resolves.toBeNull();
    await expect(
      auth.useSession({
        sessionId,
        secretDigest: "hmac:valid-secret",
        at: absoluteExpiresAt,
        idleExpiresAt: new Date("2026-09-21T20:30:00.000Z")
      })
    ).resolves.toBeNull();
  });

  it("denies revoked, idle-expired, stale-version, and disabled operator sessions", async () => {
    // Break caught: missing any use-session predicate revives a session that
    // was explicitly revoked, superseded, expired, or belongs to a disabled operator.
    const auth = repositories.operatorAuth;
    const operator = await provisionOperator();
    const at = new Date("2026-09-21T12:00:00.000Z");
    const absoluteExpiresAt = new Date("2026-09-21T20:00:00.000Z");
    const cases = [
      {
        id: "10000000-0000-0000-0000-000000000002",
        digest: "hmac:revoked",
        idleExpiresAt: new Date("2026-09-21T12:30:00.000Z")
      },
      {
        id: "10000000-0000-0000-0000-000000000003",
        digest: "hmac:idle-expired",
        idleExpiresAt: at
      },
      {
        id: "10000000-0000-0000-0000-000000000004",
        digest: "hmac:stale-version",
        idleExpiresAt: new Date("2026-09-21T12:30:00.000Z"),
        credentialVersion: 0
      },
      {
        id: "10000000-0000-0000-0000-000000000005",
        digest: "hmac:disabled",
        idleExpiresAt: new Date("2026-09-21T12:30:00.000Z")
      }
    ];
    for (const session of cases) {
      await auth.issueSession({
        sessionId: session.id,
        secretDigest: session.digest,
        operatorId: operator.id,
        credentialVersion:
          session.credentialVersion ?? operator.credentialVersion,
        issuedAt: at,
        lastUsedAt: at,
        idleExpiresAt: session.idleExpiresAt,
        absoluteExpiresAt
      });
    }
    await auth.revokeSession(cases[0]!.id, at);
    for (const session of cases.slice(0, 3)) {
      await expect(
        auth.useSession({
          sessionId: session.id,
          secretDigest: session.digest,
          at,
          idleExpiresAt: new Date("2026-09-21T12:30:00.000Z")
        })
      ).resolves.toBeNull();
    }
    await pool.query("UPDATE operators SET active = false WHERE id = $1", [
      operator.id
    ]);
    await expect(
      auth.useSession({
        sessionId: cases[3]!.id,
        secretDigest: cases[3]!.digest,
        at,
        idleExpiresAt: new Date("2026-09-21T12:30:00.000Z")
      })
    ).resolves.toBeNull();
  });

  it("rotates and disables credentials with session revocation and safe audit evidence", async () => {
    // Break caught: credential lifecycle changes that leave old sessions alive
    // or make lifecycle evidence disappear from the same durable operation.
    const auth = repositories.operatorAuth;
    const operator = await provisionOperator();
    const at = new Date("2026-09-21T12:00:00.000Z");
    const firstSession = "10000000-0000-0000-0000-000000000006";
    const secondSession = "10000000-0000-0000-0000-000000000007";
    const issue = async (sessionId: string, credentialVersion: number) =>
      auth.issueSession({
        sessionId,
        secretDigest: `hmac:${sessionId}`,
        operatorId: operator.id,
        credentialVersion,
        issuedAt: at,
        lastUsedAt: at,
        idleExpiresAt: new Date("2026-09-21T12:30:00.000Z"),
        absoluteExpiresAt: new Date("2026-09-21T20:00:00.000Z")
      });

    await issue(firstSession, operator.credentialVersion);
    await expect(
      auth.rotateCredential({
        operatorId: operator.id,
        passwordHash: "rotated-password-hash",
        passwordSalt: "rotated-password-salt",
        scryptVersion: 2,
        scryptCost: 32_768,
        at
      })
    ).resolves.toMatchObject({
      id: operator.id,
      credentialVersion: 2,
      active: true
    });
    await expect(
      auth.useSession({
        sessionId: firstSession,
        secretDigest: `hmac:${firstSession}`,
        at,
        idleExpiresAt: new Date("2026-09-21T12:30:00.000Z")
      })
    ).resolves.toBeNull();

    await issue(secondSession, 2);
    await expect(auth.disable(operator.id, at)).resolves.toMatchObject({
      id: operator.id,
      active: false,
      credentialVersion: 2
    });
    await expect(
      auth.useSession({
        sessionId: secondSession,
        secretDigest: `hmac:${secondSession}`,
        at,
        idleExpiresAt: new Date("2026-09-21T12:30:00.000Z")
      })
    ).resolves.toBeNull();

    const events = await pool.query<{
      operator_id: string;
      action: string;
      outcome: string;
    }>(`SELECT operator_id, action, outcome FROM operator_auth_events
       ORDER BY id`);
    expect(events.rows).toEqual([
      { operator_id: operator.id, action: "provision", outcome: "success" },
      { operator_id: operator.id, action: "rotate", outcome: "success" },
      { operator_id: operator.id, action: "disable", outcome: "success" }
    ]);
  });

  it("bounds hashed throttle buckets and cleans up only expired or revoked auth records", async () => {
    // Break caught: a throttle that lets a hash exceed its window, conflates
    // independently derived buckets, or cleanup that deletes live sessions.
    const auth = repositories.operatorAuth;
    const operator = await provisionOperator();
    const at = new Date("2026-09-21T12:00:00.000Z");
    const expiresAt = new Date("2026-09-21T12:15:00.000Z");
    await expect(
      auth.admitLoginAttempt({
        subjectHash: "hmac:login-and-address",
        limit: 2,
        expiresAt,
        at
      })
    ).resolves.toEqual({ kind: "admitted" });
    await expect(
      auth.admitLoginAttempt({
        subjectHash: "hmac:login-and-address",
        limit: 2,
        expiresAt,
        at
      })
    ).resolves.toEqual({ kind: "admitted" });
    await expect(
      auth.admitLoginAttempt({
        subjectHash: "hmac:login-and-address",
        limit: 2,
        expiresAt,
        at
      })
    ).resolves.toEqual({ kind: "throttled", retryAt: expiresAt });
    await expect(
      auth.admitLoginAttempt({
        subjectHash: "hmac:global-fallback",
        limit: 2,
        expiresAt,
        at
      })
    ).resolves.toEqual({ kind: "admitted" });

    await auth.issueSession({
      sessionId: "10000000-0000-0000-0000-000000000008",
      secretDigest: "hmac:revoked-cleanup",
      operatorId: operator.id,
      credentialVersion: operator.credentialVersion,
      issuedAt: at,
      lastUsedAt: at,
      idleExpiresAt: new Date("2026-09-21T12:30:00.000Z"),
      absoluteExpiresAt: new Date("2026-09-21T20:00:00.000Z")
    });
    await auth.revokeSession("10000000-0000-0000-0000-000000000008", at);
    await auth.issueSession({
      sessionId: "10000000-0000-0000-0000-000000000009",
      secretDigest: "hmac:live-cleanup",
      operatorId: operator.id,
      credentialVersion: operator.credentialVersion,
      issuedAt: at,
      lastUsedAt: at,
      idleExpiresAt: new Date("2026-09-21T12:30:00.000Z"),
      absoluteExpiresAt: new Date("2026-09-21T20:00:00.000Z")
    });
    await expect(auth.cleanupExpired(expiresAt)).resolves.toEqual({
      sessions: 1,
      loginAttempts: 3
    });
    await expect(
      auth.useSession({
        sessionId: "10000000-0000-0000-0000-000000000009",
        secretDigest: "hmac:live-cleanup",
        at: new Date("2026-09-21T12:16:00.000Z"),
        idleExpiresAt: new Date("2026-09-21T12:46:00.000Z")
      })
    ).resolves.toMatchObject({ operator: { id: operator.id } });
  });

  it("appends audit rows that contain only the allowed safe fields", async () => {
    // Break caught: audit logging that stores any credential or session
    // material, or drops unknown-identity failures.
    const auth = repositories.operatorAuth;
    await auth.appendEvent({
      operatorId: null,
      action: "sign_in",
      outcome: "failure",
      at: new Date("2026-09-21T12:00:00.000Z")
    });

    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'operator_auth_events'
       ORDER BY ordinal_position`
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "id",
      "operator_id",
      "action",
      "outcome",
      "occurred_at"
    ]);
    await expect(
      pool.query(
        "SELECT operator_id, action, outcome, occurred_at FROM operator_auth_events"
      )
    ).resolves.toMatchObject({
      rows: [
        {
          operator_id: null,
          action: "sign_in",
          outcome: "failure",
          occurred_at: new Date("2026-09-21T12:00:00.000Z")
        }
      ]
    });
  });
});
