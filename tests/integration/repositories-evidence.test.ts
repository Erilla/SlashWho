import {
  createApplicantEvidenceJobHandler,
  recoverAbandonedEvidenceRuns
} from "../../packages/application/src";
import type { CharacterKey } from "@slashwho/domain";
import type { Pool } from "pg";
import {
  createPostgresRepositories,
  type CharacterMythicKillInput
} from "../../packages/database/src";
import type { WarcraftLogsGateway } from "../../packages/warcraftlogs/src";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  rootKey,
  altKey,
  mythicKill,
  mythicWipe,
  seedCompleteSnapshot,
  resetRepositoryTables,
  startRepositoryDatabase
} from "./repository-fixtures";
import type { TestRepositories } from "./test-repositories";

/**
 * Evidence runs: reservation, publication, carried and terminal evidence,
 * parses, credentials, history bookmarks, and resumable and abandoned runs.
 *
 * Split from one file so each area runs in parallel with its own PostgreSQL;
 * the shared set-up is in `repository-fixtures.ts`.
 */
describe("PostgreSQL repositories: character evidence", () => {
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

  it("round-trips a Mythic kill's Warcraft Logs guild region", async () => {
    // Historical-guild traversal can only safely call Blizzard when the
    // region was observed with the public report; a realm alone is ambiguous.
    const reservation = await repositories.evidence.reserve({
      origin: "dossier_read",
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

  it("round-trips awkward text, nulls and a zero percentile through the batched publish", async () => {
    // publish sends each column as one array. Array literals have their own
    // quoting, so text that needs escaping and a legitimate numeric zero are
    // what a mistake there would corrupt.
    const awkward = 'Boss "Quoted", {braced} \\ back\\slash';
    const reservation = await repositories.evidence.reserve({
      origin: "dossier_read",
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
          bossName: awkward,
          journalBossId: null,
          guild: null,
          performance: {
            spec: null,
            damage: { state: "available", percentile: 0 },
            healing: { state: "not_applicable" },
            bossDamage: { state: "available", percentile: 99.5 }
          }
        }),
        mythicKill({
          bossId: "1235",
          fightUrl: "https://www.warcraftlogs.com/reports/example#fight=2"
        })
      ],
      wipes: [mythicWipe({ bossName: awkward, journalBossId: null })],
      tierBests: [
        {
          raidId: "42",
          raidName: "NULL",
          bossId: "1234",
          bossName: awkward,
          rankingsUrl: "https://www.warcraftlogs.com/character/eu/x#boss=1234",
          performance: {
            spec: { name: "Fire", iconUrl: "https://example.test/fire.jpg" },
            damage: { state: "available", percentile: 0 },
            healing: { state: "unavailable" },
            bossDamage: { state: "unavailable" }
          }
        }
      ],
      completedAt: new Date("2026-08-04T12:05:00.000Z")
    });

    const completed = await repositories.evidence.getCompleted(rootKey);
    expect(completed?.kills).toHaveLength(2);
    const kill = completed?.kills.find((stored) => stored.bossId === "1234");
    expect(kill).toMatchObject({
      bossName: awkward,
      journalBossId: null,
      guild: null,
      performance: {
        damage: { state: "available", percentile: 0 },
        healing: { state: "not_applicable" },
        bossDamage: { state: "available", percentile: 99.5 }
      }
    });
    expect(completed?.wipes).toMatchObject([
      { bossName: awkward, journalBossId: null }
    ]);
    expect(completed?.tierBests).toMatchObject([
      {
        raidName: "NULL",
        bossName: awkward,
        performance: {
          spec: { name: "Fire" },
          damage: { state: "available", percentile: 0 }
        }
      }
    ]);
  });

  it("persists a rankless successful lookup and carries it into later publications", async () => {
    const first = await repositories.evidence.reserve({
      origin: "dossier_read",
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
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-08-04T12:05:00.000Z")
    });
    const legacy = (await repositories.evidence.getCompleted(rootKey))
      ?.kills[0];
    expect(legacy?.historicRankCheckedAt).toBeNull();
    const checkedAt = new Date("2026-08-04T12:10:00.000Z");
    await repositories.evidence.recordHistoricRankLookup(
      legacy!.id,
      null,
      checkedAt
    );
    expect(
      (await repositories.evidence.getCompleted(rootKey))?.kills[0]
    ).toMatchObject({
      historicWorldRank: null,
      historicRankCheckedAt: checkedAt.toISOString()
    });

    const later = await repositories.evidence.reserve({
      origin: "dossier_read",
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
    expect(
      (await repositories.evidence.getCompleted(rootKey))?.kills[0]
    ).toMatchObject({
      historicWorldRank: null,
      historicRankCheckedAt: checkedAt.toISOString()
    });
  });

  it("commits an evidence run with its reserved phase plan", async () => {
    // Break caught: a process dying after reservation but before worker claim
    // used to leave no ledger at all, so an operator could not distinguish a
    // queued run from one whose progress writer had failed.
    const reservation = await repositories.evidence.reserve({
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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

  it("reads each watched run's status and step states in one query", async () => {
    // #690: the dossier page watches its runs through this read instead of
    // re-reading the whole dossier, so it has to see every step change.
    const at = new Date("2026-09-22T11:00:00.000Z");
    const reservation = await repositories.evidence.reserve({
      origin: "dossier_read",
      key: rootKey,
      freshnessCutoff: new Date("2026-09-22T10:00:00.000Z"),
      at,
      phasePlan: ["warcraft_logs_history", "publication"]
    });
    if (reservation.kind !== "reserved")
      throw new Error("evidence_not_reserved");
    const bare = await repositories.evidence.reserve({
      origin: "dossier_read",
      key: altKey,
      freshnessCutoff: new Date("2026-09-22T10:00:00.000Z"),
      at
    });
    if (bare.kind !== "reserved") throw new Error("evidence_not_reserved");
    const missing = "00000000-0000-4000-8000-000000000000";

    await expect(
      repositories.evidence.readRunProgress!(
        [reservation.run.id, bare.run.id, missing],
        at
      )
    ).resolves.toEqual(
      expect.arrayContaining([
        {
          id: reservation.run.id,
          status: "queued",
          deferred: false,
          phaseStates: ["pending", "pending"]
        },
        { id: bare.run.id, status: "queued", deferred: false, phaseStates: [] }
      ])
    );

    await repositories.evidence.claim(reservation.run.id, 1);
    await repositories.evidence.recordPhaseTransitions?.(reservation.run.id, [
      {
        id: "warcraft_logs_history",
        state: "active",
        startedAt: at,
        completedAt: null,
        limitationCode: null
      }
    ]);
    await expect(
      repositories.evidence.readRunProgress!([reservation.run.id], at)
    ).resolves.toEqual([
      {
        id: reservation.run.id,
        status: "running",
        deferred: false,
        phaseStates: ["active", "pending"]
      }
    ]);

    // A points-budget deferral leaves the run `running`, with a code.
    await repositories.evidence.recordLimitation(
      reservation.run.id,
      "rate_limited"
    );
    await expect(
      repositories.evidence.readRunProgress!([reservation.run.id], at)
    ).resolves.toEqual([
      {
        id: reservation.run.id,
        status: "running",
        deferred: true,
        phaseStates: ["active", "pending"]
      }
    ]);
    await expect(
      repositories.evidence.readRunProgress!([], at)
    ).resolves.toEqual([]);
  });

  it("leaves a suppressed character's runs out of the progress read", async () => {
    const at = new Date("2026-09-22T11:00:00.000Z");
    const reservation = await repositories.evidence.reserve({
      origin: "dossier_read",
      key: rootKey,
      freshnessCutoff: new Date("2026-09-22T10:00:00.000Z"),
      at
    });
    await repositories.suppressions.suppress(rootKey, "removal request", null);

    await expect(
      repositories.evidence.readRunProgress!([reservation.run.id], at)
    ).resolves.toEqual([]);
  });

  it("publishes normalized Blizzard achievements with the evidence run", async () => {
    // Break caught: a provider phase that does not publish its normalized
    // result only recreates the same network call on every dossier read.
    const reservation = await repositories.evidence.reserve({
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
        origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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

  it("records a queued run as a light refresh after reserving it", async () => {
    // A stale dossier read decides a run is light only after `reserve` made
    // it (#540), and the dossier reads the mark to leave the last run's
    // notices standing (#541).
    const reserved = await repositories.evidence.reserve({
      origin: "dossier_read",
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (reserved.kind !== "reserved") throw new Error("evidence_not_reserved");
    expect(reserved.run.lightRefresh).toBeUndefined();

    await repositories.evidence.markLightRefresh(reserved.run.id);

    await expect(
      repositories.evidence.find(reserved.run.id)
    ).resolves.toMatchObject({ lightRefresh: true });
    const joined = await repositories.evidence.reserve({
      origin: "dossier_read",
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T13:00:00.000Z"),
      at: new Date("2026-08-04T13:00:00.000Z")
    });
    expect(joined).toMatchObject({
      kind: "active",
      active: { id: reserved.run.id, lightRefresh: true }
    });

    // A run a worker already claimed is past being re-described.
    await repositories.evidence.claim(reserved.run.id, 1);
    await expect(
      repositories.evidence.markLightRefresh(reserved.run.id)
    ).rejects.toThrow("character_evidence_run_not_enqueuable");
  });

  it("says whether a reservation's completed evidence is from the current collector", async () => {
    // Break caught: a stale dossier read queues only the newest page for a
    // settled character (#540). A snapshot from an older collector is not
    // settled whatever its marks say, and the application layer cannot see
    // the version to tell.
    const first = await repositories.evidence.reserve({
      origin: "dossier_read",
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (first.kind !== "reserved") throw new Error("evidence_not_reserved");
    expect(first.completedVersionCurrent).toBe(false);
    await repositories.evidence.publish(first.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-08-04T12:05:00.000Z")
    });

    const stale = await repositories.evidence.reserve({
      origin: "dossier_read",
      key: rootKey,
      freshnessCutoff: new Date("2026-08-05T13:00:00.000Z"),
      at: new Date("2026-08-05T13:00:00.000Z")
    });
    if (stale.kind !== "reserved") throw new Error("evidence_not_reserved");
    expect(stale.completedVersionCurrent).toBe(true);
    await repositories.evidence.publish(stale.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-08-05T13:05:00.000Z")
    });

    await pool.query(
      `UPDATE character_evidence_runs SET evidence_version = 1
        WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
      [rootKey.region, rootKey.realm, rootKey.name]
    );
    const outdated = await repositories.evidence.reserve({
      origin: "dossier_read",
      key: rootKey,
      freshnessCutoff: new Date("2026-08-05T13:00:00.000Z"),
      at: new Date("2026-08-05T14:00:00.000Z")
    });
    if (outdated.kind !== "reserved") throw new Error("evidence_not_reserved");
    expect(outdated.completedVersionCurrent).toBe(false);
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      options: Parameters<WarcraftLogsGateway["getFirstKillReports"]>[1]
    ) => {
      // The old parse's fight, in a raid window the plan spends on, so only
      // what is stored decides whether it gets a request.
      const planned = {
        ...oldParse,
        raidName: "The Eternal Palace",
        bossId: "2299",
        killedAt: "2020-01-14T20:34:49.222Z",
        reportCode: "example",
        fightId: 1,
        difficulty: 5,
        guild: null
      };
      // The old parse is fetched again: neither stored as hydrated nor
      // terminal for parses any more.
      expect(options.plan.parseGroups([planned]).groups).toHaveLength(1);
      // Tier bests stay terminal, so the zone costs no request.
      expect(options.plan.tierZones([planned], 24)).toEqual({
        zones: [],
        unreached: []
      });
      // Kills stay terminal, so the stored kill's report is not re-read.
      expect(options.storedKillReportCodes).toEqual([]);
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T12:30:00.000Z"),
      at: new Date("2026-08-04T12:30:00.000Z")
    });
    if (refresh.kind !== "reserved") throw new Error("evidence_not_reserved");

    // What a dossier read does, concurrently, with the normal window.
    const read = await repositories.evidence.reserve({
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
        origin: "dossier_read",
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
      origin: "dossier_read",
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
        origin: "dossier_read",
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
      origin: "dossier_read",
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
        origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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

    // Steps are an in-flight concern: a finished run's ledger stays behind
    // the monitor, so only the running one should report any.
    await pool.query(
      `INSERT INTO character_evidence_run_phases
         (run_id, phase_id, ordinal, state, limitation_code)
       SELECT id, phase.phase_id, phase.ordinal, phase.state, phase.code
         FROM character_evidence_runs,
              (VALUES ('publication', 1, 'pending', NULL),
                      ('warcraft_logs_history', 0, 'limited', 'rate_limited'))
                AS phase (phase_id, ordinal, state, code)
        WHERE normalized_name IN ('running', 'complete')`
    );

    const rows = await repositories.evidence.listForMonitor({
      completedLimit: 10
    });

    expect(rows.find((row) => row.status === "running")?.phases).toEqual([
      {
        id: "warcraft_logs_history",
        state: "limited",
        limitationCode: "rate_limited"
      },
      { id: "publication", state: "pending", limitationCode: null }
    ]);
    expect(rows.find((row) => row.status === "queued")?.phases).toEqual([]);
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
      // Inserted with no origin, as every row from before #708 was.
      origin: "unknown",
      // Nor a root: an old row has none, and the monitor says so.
      root: null,
      evidenceVersion: 13,
      attempt: 1,
      limitationCode: "request_cap",
      parseLimitationCode: "parse_request_cap",
      retryAfterAt: null,
      errorCode: null,
      startedAt: new Date("2026-09-20T08:05:00Z"),
      completedAt: new Date("2026-09-20T09:00:00Z"),
      phases: []
    });
    expect(rows.find((row) => row.status === "complete")?.phases).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain("cipher");
    expect(rows.every((row) => !("id" in row) && !("queueJobId" in row))).toBe(
      true
    );
  });

  it("limits only completed runs in the monitor projection, newest first", async () => {
    // Break caught: completed runs accumulate forever, so the monitor must page
    // them; limiting the whole read instead would hide in-flight or failed runs.
    await pool.query(
      `INSERT INTO character_evidence_runs
         (region, realm_slug, normalized_name, status, evidence_version,
          attempt, created_at, started_at, completed_at, error_code)
       VALUES
         ('eu', 'silvermoon', 'queued', 'queued', 13, 0,
          '2026-09-20T09:00:00Z', NULL, NULL, NULL),
         ('eu', 'silvermoon', 'oldest', 'complete', 13, 1,
          '2026-09-20T06:00:00Z', '2026-09-20T06:05:00Z',
          '2026-09-20T07:00:00Z', NULL),
         ('eu', 'silvermoon', 'newest', 'complete', 13, 1,
          '2026-09-20T08:00:00Z', '2026-09-20T08:05:00Z',
          '2026-09-20T09:00:00Z', NULL),
         ('eu', 'silvermoon', 'middle', 'complete', 13, 1,
          '2026-09-20T07:00:00Z', '2026-09-20T07:05:00Z',
          '2026-09-20T08:00:00Z', NULL),
         ('eu', 'silvermoon', 'failed', 'failed', 13, 3,
          '2026-09-20T05:00:00Z', '2026-09-20T05:05:00Z',
          '2026-09-20T05:30:00Z', 'warcraft_logs_unavailable')`
    );

    const rows = await repositories.evidence.listForMonitor({
      completedLimit: 2
    });

    expect(rows.map((row) => row.key.name)).toEqual([
      "queued",
      "newest",
      "middle",
      "failed"
    ]);
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
            // So a combined zone's wipe can be placed in its raid (#492).
            bossName: "Nexus-Princess Ky'veza",
            journalBossId: "2920",
            attemptedAt: "2026-03-01T11:00:00.000Z",
            // So a wipe found through attendance can be re-read (#435).
            reportUrl: "https://www.warcraftlogs.com/reports/wipe"
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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

  it("remembers each character's resolved Warcraft Logs ID and its latest resolution", async () => {
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "ryun"
    } as const;
    const former = {
      region: "eu",
      realm: "neptulon",
      name: "erilla"
    } as const;

    await expect(
      repositories.evidence.warcraftLogsCharacterId(key)
    ).resolves.toBeNull();

    await repositories.evidence.recordWarcraftLogsCharacterId(
      key,
      40989140,
      new Date("2026-09-22T09:00:00.000Z")
    );
    // A former name resolving to the same ID is the rename #424 links, so the
    // ID must not be unique across keys.
    await repositories.evidence.recordWarcraftLogsCharacterId(
      former,
      40989140,
      new Date("2026-09-22T09:00:00.000Z")
    );
    await expect(
      repositories.evidence.warcraftLogsCharacterId(key)
    ).resolves.toBe(40989140);

    // A name can be released and taken by somebody else; the latest answer
    // replaces the old one rather than failing on the key.
    await repositories.evidence.recordWarcraftLogsCharacterId(
      key,
      51234567,
      new Date("2026-09-23T09:00:00.000Z")
    );
    await expect(
      repositories.evidence.warcraftLogsCharacterId(key)
    ).resolves.toBe(51234567);
    await expect(
      repositories.evidence.warcraftLogsCharacterId(former)
    ).resolves.toBe(40989140);
    const stored = await pool.query<{ resolved_at: Date }>(
      `SELECT resolved_at FROM warcraft_logs_character_ids
        WHERE region = 'eu' AND realm_slug = 'silvermoon'
          AND normalized_name = 'ryun'`
    );
    expect(stored.rows[0]?.resolved_at.toISOString()).toBe(
      "2026-09-23T09:00:00.000Z"
    );
  });

  it("reads the recorded Warcraft Logs IDs of many keys at once", async () => {
    const current = {
      region: "eu",
      realm: "silvermoon",
      name: "batchryun"
    } as const;
    const former = {
      region: "eu",
      realm: "neptulon",
      name: "batcherilla"
    } as const;
    const unknown = {
      region: "eu",
      realm: "silvermoon",
      name: "batchunknown"
    } as const;
    await repositories.evidence.recordWarcraftLogsCharacterId(
      current,
      40989141,
      new Date("2026-09-22T09:00:00.000Z")
    );
    await repositories.evidence.recordWarcraftLogsCharacterId(
      former,
      40989141,
      new Date("2026-09-22T09:00:00.000Z")
    );

    const recorded = await repositories.evidence.warcraftLogsCharacterIds!([
      current,
      former,
      unknown
    ]);

    expect(
      [...recorded].sort((left, right) =>
        left.key.name.localeCompare(right.key.name)
      )
    ).toEqual([
      { key: former, characterId: 40989141 },
      { key: current, characterId: 40989141 }
    ]);
    await expect(
      repositories.evidence.warcraftLogsCharacterIds!([])
    ).resolves.toEqual([]);
  });

  it("refuses to store a Warcraft Logs ID that is not a positive integer", async () => {
    const key = { region: "eu", realm: "silvermoon", name: "badid" } as const;
    for (const id of [0, -1, 1.5]) {
      await expect(
        repositories.evidence.recordWarcraftLogsCharacterId(
          key,
          id,
          new Date("2026-09-22T09:00:00.000Z")
        )
      ).rejects.toThrow();
    }
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
        origin: "dossier_read",
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
        origin: "dossier_read",
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

  it("stores permanent timestamp omissions on a complete run", async () => {
    const reserved = await repositories.evidence.reserve({
      origin: "dossier_read",
      key: { ...rootKey, name: "timestampomissions" },
      freshnessCutoff: new Date("2026-08-04T12:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (reserved.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(reserved.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      omittedInvalidTimestamp: true,
      kills: [],
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-08-04T12:05:00.000Z")
    });

    await expect(
      repositories.evidence.find(reserved.run.id)
    ).resolves.toMatchObject({
      status: "complete",
      limitationCode: null,
      omittedInvalidTimestamp: true
    });
  });

  it("round-trips normalized kill parses", async () => {
    // Break caught: storage could lose a normalized parse state or percentile,
    // including a valid zero, while replacing a completed evidence scan.
    const initial = await repositories.evidence.reserve({
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      kills: readonly {
        id: string;
        parsesReadAt: string | null;
        historicRankCheckedAt?: string | null;
      }[]
    ) =>
      kills.map((kill) => {
        const { id, parsesReadAt, historicRankCheckedAt, ...rest } = kill;
        void id;
        void parsesReadAt;
        void historicRankCheckedAt;
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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

  it("keeps the first account key reference when another account joins a run", async () => {
    const accounts = await pool.query<{ id: string }>(
      `INSERT INTO accounts (canonical_email, email, password_hash, password_salt, scrypt_version, scrypt_cost, verified_at)
       VALUES ('evidence-a@example.com', 'evidence-a@example.com', 'hash', 'salt', 1, 16384, now()),
              ('evidence-b@example.com', 'evidence-b@example.com', 'hash', 'salt', 1, 16384, now()) RETURNING id`
    );
    const [alice, bob] = accounts.rows.map((row) => row.id);
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "Accountjoined"
    } as const;
    const first = await repositories.evidence.reserve({
      origin: "dossier_read",
      key,
      freshnessCutoff: new Date(0),
      at: new Date(),
      credentials: { accountId: alice!, credentialVersion: 1 }
    });
    const joined = await repositories.evidence.reserve({
      origin: "dossier_read",
      key,
      freshnessCutoff: new Date(0),
      at: new Date(),
      credentials: { accountId: bob!, credentialVersion: 1 }
    });
    expect(first.kind).toBe("reserved");
    expect(joined.kind).toBe("active");
    expect(joined.run.id).toBe(first.run.id);
    expect(joined.run.accountCredentialOwnerId).toBe(alice);
    expect(joined.run.accountCredentialVersion).toBe(1);
    expect(
      (await repositories.evidence.find(first.run.id))?.accountCredentialOwnerId
    ).toBe(alice);
    const claimed = await repositories.evidence.claim(first.run.id, 1);
    expect(claimed?.accountCredentialOwnerId).toBe(alice);
    expect(claimed?.accountCredentialVersion).toBe(1);
    expect(claimed?.wclClientIdEncrypted).toBeNull();

    const concurrentKey = { ...key, name: "Accountconcurrent" };
    const callers = [alice!, bob!];
    const concurrent = await Promise.all(
      callers.map((accountId) =>
        repositories.evidence.reserve({
          origin: "dossier_read",
          key: concurrentKey,
          freshnessCutoff: new Date(0),
          at: new Date(),
          credentials: { accountId, credentialVersion: 1 }
        })
      )
    );
    expect(concurrent.map((result) => result.kind).sort()).toEqual([
      "active",
      "reserved"
    ]);
    const winner = concurrent.findIndex((result) => result.kind === "reserved");
    expect(concurrent[0]!.run.id).toBe(concurrent[1]!.run.id);
    expect(concurrent[0]!.run.accountCredentialOwnerId).toBe(callers[winner]);
    expect(concurrent[1]!.run.accountCredentialOwnerId).toBe(callers[winner]);
  });

  it("clears encrypted WCL credentials when a run is published", async () => {
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "Testcharacter2"
    } as const;
    const reservation = await repositories.evidence.reserve({
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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

  it("records a light refresh on the run it reserves, and on no other", async () => {
    // Break caught (#541 review): the light/full distinction lived only in
    // the queue payload, so a reader could not tell a one-page refresh from a
    // collection that re-reads the last full run's shortfalls.
    const light = {
      region: "eu",
      realm: "silvermoon",
      name: "Testcharacterlight1"
    } as const;
    const full = { ...light, name: "Testcharacterlight2" } as const;
    const lightRun = await repositories.evidence.reserve({
      origin: "dossier_read",
      key: light,
      freshnessCutoff: new Date(0),
      at: new Date(),
      lightRefresh: true
    });
    const fullRun = await repositories.evidence.reserve({
      origin: "dossier_read",
      key: full,
      freshnessCutoff: new Date(0),
      at: new Date()
    });

    expect(lightRun.run.lightRefresh).toBe(true);
    expect(
      (await repositories.evidence.find(lightRun.run.id))?.lightRefresh
    ).toBe(true);
    expect(fullRun.run.lightRefresh).toBeUndefined();
    // Joining the run in flight neither upgrades nor downgrades it.
    const joined = await repositories.evidence.reserve({
      origin: "dossier_read",
      key: light,
      freshnessCutoff: new Date(0),
      at: new Date()
    });
    expect(joined.kind).toBe("active");
    expect(joined.active?.lightRefresh).toBe(true);
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
      origin: "dossier_read",
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
      origin: "dossier_read",
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
        origin: "dossier_read",
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

    it("reports a waiting run's deadline through listStatus", async () => {
      // listStatus once carried its own copy of the run column list and
      // dropped retry_after_at, so the deadline came back undefined.
      const deadline = new Date("2026-09-18T12:40:00.000Z");
      const runId = await publishWaiting(rootKey, deadline);

      const [status] = await repositories.evidence.listStatus([rootKey]);
      expect(status?.id).toBe(runId);
      expect(status?.retryAfterAt).toEqual(deadline);
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
        origin: "dossier_read",
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
        origin: "dossier_read",
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
        origin: "dossier_read",
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
        origin: "dossier_read",
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
        origin: "dossier_read",
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

  it("keeps a history bookmark only when a later run carries it forward", async () => {
    // Break caught: a light refresh left the bookmark out of its publish,
    // expecting storage to keep it. The bookmark lives on each run's own row
    // and is read from the newest published run, so the omission cleared it.
    await seedCompleteSnapshot(repositories);
    const publishRun = async (
      minute: number,
      bookmark: Readonly<{
        historyScanResumePage?: number;
        historyScanResumeBoundaryReportCode?: string | null;
      }>
    ) => {
      const reservation = await repositories.evidence.reserve({
        origin: "dossier_read",
        key: rootKey,
        freshnessCutoff: new Date(`2026-09-20T12:${minute}:00.000Z`),
        at: new Date(`2026-09-20T12:${minute + 1}:00.000Z`)
      });
      if (reservation.kind !== "reserved") throw new Error("run_not_reserved");
      await repositories.evidence.publish(reservation.run.id, {
        state: "partial",
        limitationCode: "request_cap",
        parseLimitationCode: null,
        ...bookmark,
        kills: [],
        wipes: [],
        tierBests: [],
        completedAt: new Date(`2026-09-20T12:${minute + 2}:00.000Z`)
      });
    };
    const stored = async () =>
      createPostgresRepositories(pool).evidence.storedEvidenceTiers(rootKey);

    await publishRun(10, {
      historyScanResumePage: 19,
      historyScanResumeBoundaryReportCode: "newest-proved-report"
    });
    await publishRun(20, {
      historyScanResumePage: 19,
      historyScanResumeBoundaryReportCode: "newest-proved-report"
    });
    await expect(stored()).resolves.toMatchObject({
      historyScanResumePage: 19,
      historyScanResumeBoundaryReportCode: "newest-proved-report"
    });

    await publishRun(30, {});
    expect((await stored()).historyScanResumePage).toBeUndefined();
  });

  it("keeps a former name's bookmark when a later light run carries it forward", async () => {
    // A light refresh scans no former name and republishes each alias's
    // stored progress on its own row. The progress is read from the newest
    // published run that holds any, so what that run carries is what stands.
    await seedCompleteSnapshot(repositories);
    const alias = { region: "eu", realm: "neptulon", name: "erilla" } as const;
    const progress = {
      key: alias,
      pendingParseFightUrls: [],
      historyScanResumePage: 7,
      historyScanResumeBoundaryReportCode: "alias-boundary",
      historyComplete: false,
      parseWorkOutstanding: false
    };
    const publishRun = async (
      minute: number,
      historicAliasProgress: (typeof progress)[]
    ) => {
      const reservation = await repositories.evidence.reserve({
        origin: "dossier_read",
        key: rootKey,
        freshnessCutoff: new Date(`2026-09-20T12:${minute}:00.000Z`),
        at: new Date(`2026-09-20T12:${minute + 1}:00.000Z`)
      });
      if (reservation.kind !== "reserved") throw new Error("run_not_reserved");
      await repositories.evidence.publish(reservation.run.id, {
        state: "partial",
        limitationCode: "request_cap",
        parseLimitationCode: null,
        historicAliasProgress,
        kills: [],
        wipes: [],
        tierBests: [],
        completedAt: new Date(`2026-09-20T12:${minute + 2}:00.000Z`)
      });
    };
    const stored = async () =>
      (
        await createPostgresRepositories(pool).evidence.storedEvidenceTiers(
          rootKey
        )
      ).historicAliasProgress;

    await publishRun(10, [progress]);
    await publishRun(20, [progress]);
    await expect(stored()).resolves.toEqual([progress]);

    // An empty list is a statement, not an omission: it clears the bookmark.
    await publishRun(30, []);
    await expect(stored()).resolves.toEqual([]);
  });
});
