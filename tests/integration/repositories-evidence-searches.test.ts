import { readFileSync } from "node:fs";
import type { CharacterKey } from "@slashwho/domain";
import type { Pool } from "pg";
import type { EvidenceRunCost } from "../../packages/database/src";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  rootKey,
  altKey,
  mythicKill,
  mythicWipe,
  resetRepositoryTables,
  startRepositoryDatabase
} from "./repository-fixtures";
import type { TestRepositories } from "./test-repositories";

/**
 * The fenced SQL blocks in an operations document, in order. The queries in
 * `docs/operations/evidence-run-cost.md` are run from the document itself so
 * that a column renamed out from under them fails the suite rather than
 * leaving a document that quietly stopped being true.
 */
const SQL_BLOCK = /```sql\n([\s\S]*?)```/g;

/**
 * Tier searches, attendance searches found empty, and evidence run costs.
 *
 * Split from one file so each area runs in parallel with its own PostgreSQL;
 * the shared set-up is in `repository-fixtures.ts`.
 */
describe("PostgreSQL repositories: evidence searches and costs", () => {
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

  describe("tier searches", () => {
    // A tier search is one explicit, bounded request from the dossier (#435).
    // Nothing but `reserveTierSearch` creates one, and it is rate limited per
    // tier and per character where the reservation is decided: under the
    // character's lock.
    const tier = "1180";
    const searchedAt = new Date("2026-09-23T12:00:00.000Z");
    const dayBefore = new Date(searchedAt.getTime() - 24 * 60 * 60 * 1_000);

    async function publishEvidence(key: CharacterKey, at: Date) {
      const reservation = await repositories.evidence.reserve({
        key,
        freshnessCutoff: at,
        at
      });
      if (reservation.kind !== "reserved") {
        throw new Error("evidence_not_reserved");
      }
      await repositories.evidence.claim(reservation.run.id, 1);
      await repositories.evidence.publish(reservation.run.id, {
        state: "complete",
        limitationCode: null,
        parseLimitationCode: null,
        kills: [
          {
            ...mythicKill(),
            guild: { name: "Stored Guild", realm: "silvermoon", region: "eu" }
          }
        ],
        wipes: [],
        tierBests: [],
        completedAt: at
      });
    }

    it("refuses a character with no evidence yet to add to", async () => {
      await expect(
        repositories.evidence.reserveTierSearch({
          key: rootKey,
          raidId: tier,
          at: searchedAt,
          searchedSince: dayBefore
        })
      ).resolves.toEqual({ kind: "no_evidence" });
    });

    it("reserves a run that stays a tier search when it is claimed", async () => {
      // Break caught: the mode lived only in the queue payload, so a run the
      // recovery sweep re-enqueued came back as an ordinary collection.
      await publishEvidence(rootKey, new Date("2026-09-22T12:00:00.000Z"));

      const reservation = await repositories.evidence.reserveTierSearch({
        key: rootKey,
        raidId: tier,
        at: searchedAt,
        searchedSince: dayBefore,
        phasePlan: ["publication"]
      });
      if (reservation.kind !== "reserved") {
        throw new Error("tier_search_not_reserved");
      }

      expect(reservation.run).toMatchObject({
        mode: "tier_search",
        tierSearchRaidId: tier,
        status: "queued"
      });
      await expect(
        repositories.evidence.claim(reservation.run.id, 1)
      ).resolves.toMatchObject({ mode: "tier_search", tierSearchRaidId: tier });
      await expect(
        repositories.evidence.listPhases!(reservation.run.id)
      ).resolves.toEqual([expect.objectContaining({ id: "publication" })]);
    });

    it("joins nothing while any run for the character is in flight", async () => {
      await publishEvidence(rootKey, new Date("2026-09-22T12:00:00.000Z"));
      const ordinary = await repositories.evidence.reserve({
        key: rootKey,
        freshnessCutoff: searchedAt,
        at: searchedAt
      });

      await expect(
        repositories.evidence.reserveTierSearch({
          key: rootKey,
          raidId: tier,
          at: searchedAt,
          searchedSince: dayBefore
        })
      ).resolves.toMatchObject({
        kind: "active",
        run: { id: ordinary.run.id, mode: "full" }
      });
    });

    it("refuses the same tier again inside the window, whatever became of the last search", async () => {
      // Repeated clicks must not burn the hourly allowance, and a search that
      // failed was still paid for.
      await publishEvidence(rootKey, new Date("2026-09-22T12:00:00.000Z"));
      const first = await repositories.evidence.reserveTierSearch({
        key: rootKey,
        raidId: tier,
        at: new Date("2026-09-23T06:00:00.000Z"),
        searchedSince: new Date("2026-09-22T06:00:00.000Z")
      });
      if (first.kind !== "reserved")
        throw new Error("tier_search_not_reserved");
      await repositories.evidence.claim(first.run.id, 1);
      await repositories.evidence.fail(first.run.id, "unavailable");

      await expect(
        repositories.evidence.reserveTierSearch({
          key: rootKey,
          raidId: tier,
          at: searchedAt,
          searchedSince: dayBefore
        })
      ).resolves.toMatchObject({ kind: "recent", run: { id: first.run.id } });
      // Another tier is not limited by it, and nor is the same tier once the
      // window has passed.
      const other = await repositories.evidence.reserveTierSearch({
        key: rootKey,
        raidId: "1190",
        at: searchedAt,
        searchedSince: dayBefore
      });
      expect(other).toMatchObject({ kind: "reserved" });
      if (other.kind !== "reserved")
        throw new Error("tier_search_not_reserved");
      await repositories.evidence.claim(other.run.id, 1);
      await repositories.evidence.fail(other.run.id, "unavailable");
      await expect(
        repositories.evidence.reserveTierSearch({
          key: rootKey,
          raidId: tier,
          at: searchedAt,
          searchedSince: new Date("2026-09-23T07:00:00.000Z")
        })
      ).resolves.toMatchObject({ kind: "reserved" });
    });

    it("keeps one character's searches from limiting another's", async () => {
      await publishEvidence(rootKey, new Date("2026-09-22T12:00:00.000Z"));
      await publishEvidence(altKey, new Date("2026-09-22T12:00:00.000Z"));
      await repositories.evidence.reserveTierSearch({
        key: rootKey,
        raidId: tier,
        at: searchedAt,
        searchedSince: dayBefore
      });

      await expect(
        repositories.evidence.reserveTierSearch({
          key: altKey,
          raidId: tier,
          at: searchedAt,
          searchedSince: dayBefore
        })
      ).resolves.toMatchObject({ kind: "reserved" });
    });

    it("reports each tier's newest search since a time, for the dossier", async () => {
      await publishEvidence(rootKey, new Date("2026-09-22T12:00:00.000Z"));
      const old = await repositories.evidence.reserveTierSearch({
        key: rootKey,
        raidId: tier,
        at: new Date("2026-09-20T12:00:00.000Z"),
        searchedSince: new Date("2026-09-19T12:00:00.000Z")
      });
      if (old.kind !== "reserved") throw new Error("tier_search_not_reserved");
      await repositories.evidence.claim(old.run.id, 1);
      await repositories.evidence.fail(old.run.id, "unavailable");
      const recent = await repositories.evidence.reserveTierSearch({
        key: rootKey,
        raidId: tier,
        at: searchedAt,
        searchedSince: dayBefore
      });
      if (recent.kind !== "reserved") {
        throw new Error("tier_search_not_reserved");
      }
      // Only the newest search of the tier is reported, in its current state.
      await pool.query(
        `UPDATE character_evidence_runs SET status = 'running' WHERE id = $1`,
        [recent.run.id]
      );

      await expect(
        repositories.evidence.latestTierSearches([rootKey], dayBefore)
      ).resolves.toEqual([
        {
          key: rootKey,
          raidId: tier,
          status: "running",
          createdAt: searchedAt,
          runId: recent.run.id
        }
      ]);
      await expect(
        repositories.evidence.latestTierSearches([altKey], dayBefore)
      ).resolves.toEqual([]);
    });

    it("reports every dossier character's newest search of each tier in one read", async () => {
      // A dossier searches a tier for every included character (#449), so it
      // reads each character's newest search, never only the submitted one's.
      await publishEvidence(rootKey, new Date("2026-09-22T12:00:00.000Z"));
      await publishEvidence(altKey, new Date("2026-09-22T12:00:00.000Z"));
      const root = await repositories.evidence.reserveTierSearch({
        key: rootKey,
        raidId: tier,
        at: searchedAt,
        searchedSince: dayBefore
      });
      const alt = await repositories.evidence.reserveTierSearch({
        key: altKey,
        raidId: tier,
        at: new Date(searchedAt.getTime() + 1_000),
        searchedSince: dayBefore
      });
      if (root.kind !== "reserved" || alt.kind !== "reserved") {
        throw new Error("tier_search_not_reserved");
      }
      await repositories.evidence.claim(alt.run.id, 1);
      await repositories.evidence.fail(alt.run.id, "unavailable");

      const latest = await repositories.evidence.latestTierSearches(
        [rootKey, altKey, { ...rootKey, name: "nobody" }],
        dayBefore
      );

      expect(
        [...latest].sort((left, right) =>
          left.key.name.localeCompare(right.key.name, "en")
        )
      ).toEqual(
        [
          {
            key: rootKey,
            raidId: tier,
            status: "queued",
            createdAt: searchedAt,
            runId: root.run.id
          },
          {
            key: altKey,
            raidId: tier,
            status: "failed",
            createdAt: new Date(searchedAt.getTime() + 1_000),
            runId: alt.run.id
          }
        ].sort((left, right) =>
          left.key.name.localeCompare(right.key.name, "en")
        )
      );
      await expect(
        repositories.evidence.latestTierSearches([], dayBefore)
      ).resolves.toEqual([]);
    });

    it("names which characters have evidence a tier search could add to", async () => {
      // Break caught (#494 re-review): a character with nothing collected
      // read as still to search, so the tier offered a search that the
      // reservation always refuses.
      await publishEvidence(rootKey, new Date("2026-09-22T12:00:00.000Z"));
      const failed = await repositories.evidence.reserve({
        key: altKey,
        freshnessCutoff: searchedAt,
        at: searchedAt
      });
      await repositories.evidence.claim(failed.run.id, 1);
      await repositories.evidence.fail(failed.run.id, "unavailable");

      await expect(
        repositories.evidence.withCompletedEvidence!([
          rootKey,
          altKey,
          { ...rootKey, name: "nobody" }
        ])
      ).resolves.toEqual([rootKey]);
      await expect(
        repositories.evidence.withCompletedEvidence!([])
      ).resolves.toEqual([]);
    });

    it("keeps each character's tier search a run of its own, costed apart", async () => {
      // One press queues one run per character (#449); each attempt's cost is
      // recorded against that character's run, never pooled.
      await publishEvidence(rootKey, new Date("2026-09-22T12:00:00.000Z"));
      await publishEvidence(altKey, new Date("2026-09-22T12:00:00.000Z"));
      const runs = await Promise.all(
        [rootKey, altKey].map(async (key) => {
          const reservation = await repositories.evidence.reserveTierSearch({
            key,
            raidId: tier,
            at: searchedAt,
            searchedSince: dayBefore
          });
          if (reservation.kind !== "reserved") {
            throw new Error("tier_search_not_reserved");
          }
          return reservation.run;
        })
      );
      expect(new Set(runs.map((run) => run.id)).size).toBe(2);
      expect(runs.map((run) => run.tierSearchRaidId)).toEqual([tier, tier]);

      for (const [index, run] of runs.entries()) {
        await repositories.evidence.recordRunCost({
          runId: run.id,
          attempt: 1,
          outcome: "published",
          credentials: "own",
          mode: "tier_search",
          limitationCode: null,
          parseLimitationCode: null,
          pointsSpent: 100 + index,
          pointsLimitPerHour: 18_000,
          pointsRemainingBefore: 17_000,
          pointsRemainingAfter: 16_900 - index,
          requestCapUsed: 60,
          parseRequestCapUsed: 0,
          requests: {
            historyScan: 0,
            guildAttendance: 1,
            reportHydration: 1,
            zoneRankings: 0,
            fightParses: 0,
            rankingIdentities: 0
          },
          recovery: {
            raiderIoOutcome: "evidence",
            raiderIoMs: 0,
            verifiedKillsSearched: 0,
            verifiedKillsSkippedEmpty: 0,
            recoveredKills: 0
          },
          tierSearch: {
            raidId: tier,
            outcome: "complete",
            requests: 2,
            guilds: 1,
            reportsHydrated: 1,
            recoveredKills: index,
            recoveredWipes: 0
          }
        });
      }

      const costs = await pool.query<{ run_id: string; points_spent: number }>(
        `SELECT run_id, points_spent FROM character_evidence_run_costs
          WHERE run_id = ANY($1::uuid[]) ORDER BY points_spent`,
        [runs.map((run) => run.id)]
      );
      expect(costs.rows).toEqual([
        { run_id: runs[0]!.id, points_spent: 100 },
        { run_id: runs[1]!.id, points_spent: 101 }
      ]);
    });

    it("names the guilds stored kills were in, for the search to walk", async () => {
      await publishEvidence(rootKey, new Date("2026-09-22T12:00:00.000Z"));

      const stored = await repositories.evidence.storedEvidenceTiers(rootKey);

      expect(stored.guilds).toEqual([
        { name: "Stored Guild", realm: "silvermoon", region: "eu" }
      ]);
    });

    it("loads the last published ranked cursor for the same tier", async () => {
      await publishEvidence(rootKey, new Date("2026-09-22T12:00:00.000Z"));
      const reserved = await repositories.evidence.reserveTierSearch({
        key: rootKey,
        raidId: tier,
        at: searchedAt,
        searchedSince: dayBefore
      });
      if (reserved.kind !== "reserved")
        throw new Error("tier_search_not_reserved");
      await repositories.evidence.claim(reserved.run.id, 1);
      const cursor = {
        journalRaidId: tier,
        characterId: 40989140,
        zoneIds: [23],
        partitionIds: [1],
        acceptedFightKeys: ["publicReport:10"],
        zonesLoaded: true,
        zoneIndex: 0,
        encounterIds: [2299],
        encountersLoaded: true,
        encounterIndex: 0,
        metricIndex: 0,
        reportIndex: 3
      };
      await repositories.evidence.publish(reserved.run.id, {
        state: "partial",
        limitationCode: "request_cap",
        parseLimitationCode: null,
        rankedBackfillCursor: cursor,
        kills: [],
        wipes: [],
        tierBests: [],
        completedAt: searchedAt
      });

      await expect(
        repositories.evidence.storedEvidenceTiers(rootKey, tier)
      ).resolves.toMatchObject({ rankedBackfillCursor: cursor });
      await pool.query(
        `INSERT INTO character_evidence_run_costs
           (run_id, attempt, outcome, credentials, request_cap_used,
            parse_request_cap_used, tier_search_outcome)
         VALUES ($1, 1, 'published', 'own', 300, 24, 'complete')`,
        [reserved.run.id]
      );
      await expect(
        repositories.evidence.storedEvidenceTiers(rootKey, tier)
      ).resolves.toMatchObject({ tierSearchAttendanceComplete: true });
      expect(
        (await repositories.evidence.storedEvidenceTiers(rootKey, "1190"))
          .rankedBackfillCursor
      ).toBeUndefined();
    });

    it("reserves a due capped ranked walk as a tier continuation", async () => {
      await publishEvidence(rootKey, new Date("2026-09-22T12:00:00.000Z"));
      const startedAt = new Date("2026-09-23T12:00:00.000Z");
      const dueAt = new Date("2026-09-23T12:30:00.000Z");
      const first = await repositories.evidence.reserveTierSearch({
        key: rootKey,
        raidId: tier,
        at: startedAt,
        searchedSince: dayBefore
      });
      if (first.kind !== "reserved")
        throw new Error("tier_search_not_reserved");
      await repositories.evidence.claim(first.run.id, 1);
      const cursor = {
        journalRaidId: tier,
        characterId: 40989140,
        zoneIds: [23],
        partitionIds: [1],
        acceptedFightKeys: [],
        zonesLoaded: true,
        zoneIndex: 0,
        encounterIds: [2299],
        encountersLoaded: true,
        encounterIndex: 0,
        metricIndex: 0,
        reportIndex: 3
      };
      await repositories.evidence.publish(first.run.id, {
        state: "partial",
        limitationCode: "request_cap",
        parseLimitationCode: null,
        rankedBackfillCursor: cursor,
        retryAfterAt: dueAt,
        kills: [],
        wipes: [],
        tierBests: [],
        completedAt: startedAt
      });

      await expect(
        repositories.evidence.listResumable(10, new Date(dueAt.getTime() - 1))
      ).resolves.toEqual([]);
      // A separate refresh may finish while the ranked retry is waiting.
      // Its newer complete row must not hide the tier's outstanding cursor.
      const ordinaryAt = new Date("2026-09-23T12:10:00.000Z");
      const ordinary = await repositories.evidence.reserve({
        key: rootKey,
        freshnessCutoff: ordinaryAt,
        at: ordinaryAt
      });
      if (ordinary.kind !== "reserved")
        throw new Error("ordinary_run_not_reserved");
      expect(ordinary.run.mode).toBe("full");
      await repositories.evidence.claim(ordinary.run.id, 1);
      await repositories.evidence.publish(ordinary.run.id, {
        state: "complete",
        limitationCode: null,
        parseLimitationCode: null,
        kills: [],
        wipes: [],
        tierBests: [],
        completedAt: ordinaryAt
      });
      // Fresh evidence the walk will still add to says when (#663).
      const waitingAt = new Date("2026-09-23T12:15:00.000Z");
      await expect(
        repositories.evidence.reserve({
          key: rootKey,
          freshnessCutoff: ordinaryAt,
          at: waitingAt
        })
      ).resolves.toMatchObject({
        kind: "fresh",
        tierSearchResumesAt: dueAt
      });
      await expect(
        repositories.evidence.listResumable(10, dueAt)
      ).resolves.toEqual([rootKey]);
      const resumed = await repositories.evidence.reserve({
        key: rootKey,
        freshnessCutoff: new Date("2026-09-22T12:00:00.000Z"),
        at: dueAt
      });
      expect(resumed).toMatchObject({
        kind: "reserved",
        run: { mode: "tier_search", tierSearchRaidId: tier }
      });
      if (resumed.kind !== "reserved") throw new Error("resume_not_reserved");
      await expect(
        repositories.evidence.storedEvidenceTiers(rootKey, tier)
      ).resolves.toMatchObject({ rankedBackfillCursor: cursor });
      await repositories.evidence.claim(resumed.run.id, 1);
      await repositories.evidence.publish(resumed.run.id, {
        state: "complete",
        limitationCode: null,
        parseLimitationCode: null,
        rankedBackfillCursor: null,
        kills: [],
        wipes: [],
        tierBests: [],
        completedAt: dueAt
      });
      await expect(
        repositories.evidence.listResumable(10, new Date(dueAt.getTime() + 1))
      ).resolves.toEqual([]);
      await expect(
        repositories.evidence.reserveTierSearch({
          key: rootKey,
          raidId: tier,
          at: new Date(dueAt.getTime() + 1),
          searchedSince: dayBefore
        })
      ).resolves.toMatchObject({ kind: "recent" });
    });

    it("keeps a tier-search kill through an unrelated complete history run", async () => {
      await publishEvidence(rootKey, new Date("2026-09-22T12:00:00.000Z"));
      const searchedAt = new Date("2026-09-23T12:00:00.000Z");
      const searchedRaidId = "1179";
      const search = await repositories.evidence.reserveTierSearch({
        key: rootKey,
        raidId: searchedRaidId,
        at: searchedAt,
        searchedSince: dayBefore
      });
      if (search.kind !== "reserved")
        throw new Error("tier_search_not_reserved");
      await repositories.evidence.claim(search.run.id, 1);
      const historic = mythicKill({
        raidId: "23",
        raidName: "The Eternal Palace",
        bossId: "2299",
        bossName: "Queen Azshara",
        journalBossId: "2364",
        killedAt: "2019-09-01T20:00:00.000Z",
        reportUrl: "https://www.warcraftlogs.com/reports/historicRanked",
        fightUrl: "https://www.warcraftlogs.com/reports/historicRanked#fight=10"
      });
      await repositories.evidence.publish(search.run.id, {
        state: "partial",
        limitationCode: "request_cap",
        parseLimitationCode: null,
        rankedBackfillCursor: {
          journalRaidId: searchedRaidId,
          zoneIds: [23],
          partitionIds: [1],
          acceptedFightKeys: ["historicRanked:10"],
          zonesLoaded: true,
          zoneIndex: 0,
          encounterIds: [2299],
          encountersLoaded: true,
          encounterIndex: 0,
          metricIndex: 0,
          reportIndex: 1
        },
        retryAfterAt: new Date("2026-09-23T12:30:00.000Z"),
        kills: [historic],
        wipes: [],
        tierBests: [],
        completedAt: searchedAt
      });

      const refreshAt = new Date("2026-09-23T12:10:00.000Z");
      const refresh = await repositories.evidence.reserve({
        key: rootKey,
        freshnessCutoff: refreshAt,
        at: refreshAt
      });
      if (refresh.kind !== "reserved") throw new Error("refresh_not_reserved");
      await repositories.evidence.claim(refresh.run.id, 1);
      await repositories.evidence.publish(refresh.run.id, {
        state: "complete",
        limitationCode: null,
        parseLimitationCode: null,
        kills: [],
        wipes: [],
        tierBests: [],
        completedAt: refreshAt
      });

      expect(
        (await repositories.evidence.getCompleted(rootKey))?.kills
      ).toEqual([expect.objectContaining({ fightUrl: historic.fightUrl })]);
      expect(
        (
          await repositories.evidence.storedEvidenceTiers(
            rootKey,
            searchedRaidId
          )
        ).parseOnlyKills
      ).toEqual([expect.objectContaining({ fightUrl: historic.fightUrl })]);

      const resumedAt = new Date("2026-09-23T12:30:00.000Z");
      const resumed = await repositories.evidence.reserve({
        key: rootKey,
        freshnessCutoff: new Date("2026-09-22T12:00:00.000Z"),
        at: resumedAt
      });
      if (resumed.kind !== "reserved") throw new Error("resume_not_reserved");
      await repositories.evidence.claim(resumed.run.id, 1);
      await repositories.evidence.publish(resumed.run.id, {
        state: "complete",
        limitationCode: null,
        parseLimitationCode: null,
        rankedBackfillCursor: null,
        kills: [historic],
        wipes: [],
        tierBests: [],
        completedAt: resumedAt
      });
      const laterAt = new Date("2026-09-23T13:00:00.000Z");
      const later = await repositories.evidence.reserve({
        key: rootKey,
        freshnessCutoff: laterAt,
        at: laterAt
      });
      if (later.kind !== "reserved") throw new Error("later_not_reserved");
      await repositories.evidence.claim(later.run.id, 1);
      await repositories.evidence.publish(later.run.id, {
        state: "complete",
        limitationCode: null,
        parseLimitationCode: null,
        kills: [],
        wipes: [],
        tierBests: [],
        completedAt: laterAt
      });
      expect(
        (await repositories.evidence.getCompleted(rootKey))?.kills
      ).toEqual([expect.objectContaining({ fightUrl: historic.fightUrl })]);
      // A later explicit search is targeted and only ever adds (#450): one
      // that finds nothing, even cleanly, keeps what the earlier one found.
      const replacingAt = new Date(Date.now() + 25 * 60 * 60 * 1000);
      const replacing = await repositories.evidence.reserveTierSearch({
        key: rootKey,
        raidId: searchedRaidId,
        at: replacingAt,
        searchedSince: new Date(replacingAt.getTime() - 24 * 60 * 60 * 1000)
      });
      if (replacing.kind !== "reserved")
        throw new Error("replacing_search_not_reserved");
      await repositories.evidence.claim(replacing.run.id, 1);
      await repositories.evidence.publish(replacing.run.id, {
        state: "complete",
        limitationCode: null,
        parseLimitationCode: null,
        rankedBackfillCursor: null,
        kills: [],
        wipes: [],
        tierBests: [],
        completedAt: replacingAt
      });
      expect(
        (await repositories.evidence.getCompleted(rootKey))?.kills
      ).toEqual([expect.objectContaining({ fightUrl: historic.fightUrl })]);
    });

    it.each(["sql", "json"] as const)(
      "resumes ordinary work after a ranked walk finishes with %s null cursor",
      async (storedAs) => {
        await publishEvidence(rootKey, new Date("2026-09-22T12:00:00.000Z"));
        const searchedAt = new Date("2026-09-23T12:00:00.000Z");
        const searched = await repositories.evidence.reserveTierSearch({
          key: rootKey,
          raidId: "946",
          at: searchedAt,
          searchedSince: dayBefore
        });
        if (searched.kind !== "reserved")
          throw new Error("tier_search_not_reserved");
        await repositories.evidence.claim(searched.run.id, 1);
        const retryAt = new Date("2026-09-23T12:30:00.000Z");
        await repositories.evidence.publish(searched.run.id, {
          state: "partial",
          limitationCode: "request_cap",
          parseLimitationCode: null,
          rankedBackfillCursor: null,
          retryAfterAt: retryAt,
          kills: [],
          wipes: [],
          tierBests: [],
          completedAt: searchedAt
        });
        const stored = await pool.query<{ cursor_is_null: boolean }>(
          `SELECT ranked_backfill_cursor IS NULL AS cursor_is_null
           FROM character_evidence_runs WHERE id = $1`,
          [searched.run.id]
        );
        expect(stored.rows[0]?.cursor_is_null).toBe(true);
        // Prior deployments wrote JSON null; those rows must also stop the
        // ranked continuation instead of restarting it from partition one.
        if (storedAs === "json") {
          await pool.query(
            `UPDATE character_evidence_runs
              SET ranked_backfill_cursor = 'null'::jsonb WHERE id = $1`,
            [searched.run.id]
          );
        }
        // Nothing is left for the finished walk to continue, and a targeted
        // search's own deadline does not make ordinary evidence due (#450).
        expect(await repositories.evidence.listResumable(10, retryAt)).toEqual(
          []
        );
        const resumed = await repositories.evidence.reserve({
          key: rootKey,
          freshnessCutoff: retryAt,
          at: retryAt
        });
        if (resumed.kind !== "reserved") throw new Error("resume_not_reserved");
        expect(resumed.run.mode).toBe("full");
      }
    );

    it("continues the saved cursor after a failed continuation cools down", async () => {
      await publishEvidence(rootKey, new Date("2026-09-22T12:00:00.000Z"));
      const first = await repositories.evidence.reserveTierSearch({
        key: rootKey,
        raidId: tier,
        at: searchedAt,
        searchedSince: dayBefore
      });
      if (first.kind !== "reserved")
        throw new Error("tier_search_not_reserved");
      await repositories.evidence.claim(first.run.id, 1);
      await repositories.evidence.publish(first.run.id, {
        state: "partial",
        limitationCode: "request_cap",
        parseLimitationCode: null,
        rankedBackfillCursor: {
          journalRaidId: tier,
          zoneIds: [23],
          partitionIds: [1],
          zonesLoaded: true,
          zoneIndex: 0,
          encounterIds: [2299],
          encountersLoaded: true,
          encounterIndex: 0,
          metricIndex: 0,
          reportIndex: 1
        },
        retryAfterAt: new Date("2026-09-23T12:30:00.000Z"),
        kills: [],
        wipes: [],
        tierBests: [],
        completedAt: searchedAt
      });
      const dueAt = new Date();
      const continuation = await repositories.evidence.reserve({
        key: rootKey,
        at: dueAt,
        freshnessCutoff: new Date(dueAt.getTime() - 24 * 60 * 60 * 1000)
      });
      if (continuation.kind !== "reserved")
        throw new Error("continuation_not_reserved");
      expect(continuation.run.mode).toBe("tier_search");
      await repositories.evidence.claim(continuation.run.id, 1);
      await repositories.evidence.fail(
        continuation.run.id,
        "points_budget_low"
      );
      const failed = await pool.query<{ completed_at: Date }>(
        `SELECT completed_at FROM character_evidence_runs WHERE id = $1`,
        [continuation.run.id]
      );
      const failedAt = failed.rows[0]!.completed_at;

      await expect(
        repositories.evidence.listResumable(
          10,
          new Date(failedAt.getTime() + 29 * 60 * 1000)
        )
      ).resolves.toEqual([]);
      // The cool-down, not the walk's own retry time, is when it continues.
      await expect(
        repositories.evidence.reserve({
          key: rootKey,
          freshnessCutoff: new Date("2026-09-22T12:00:00.000Z"),
          at: new Date(failedAt.getTime() + 29 * 60 * 1000)
        })
      ).resolves.toMatchObject({
        kind: "fresh",
        tierSearchResumesAt: new Date(failedAt.getTime() + 30 * 60 * 1000)
      });
      const retriedAt = new Date(failedAt.getTime() + 30 * 60 * 1000 + 1);
      await expect(
        repositories.evidence.listResumable(10, retriedAt)
      ).resolves.toEqual([rootKey]);
      const retried = await repositories.evidence.reserve({
        key: rootKey,
        freshnessCutoff: new Date(retriedAt.getTime() - 24 * 60 * 60 * 1000),
        at: retriedAt
      });
      expect(retried).toMatchObject({
        kind: "reserved",
        run: { mode: "tier_search", tierSearchRaidId: tier }
      });
    });

    describe("as a targeted, additive publication (#450)", () => {
      const ordinaryAt = new Date("2026-09-22T12:00:00.000Z");
      const palace = mythicKill({
        raidId: "23",
        raidName: "The Eternal Palace",
        bossId: "2299",
        bossName: "Queen Azshara",
        journalBossId: "2364",
        killedAt: "2019-09-01T20:00:00.000Z",
        reportUrl: "https://www.warcraftlogs.com/reports/palaceStored",
        fightUrl: "https://www.warcraftlogs.com/reports/palaceStored#fight=4"
      });
      const nerubar = mythicKill();
      const storedWipe = mythicWipe();
      const storedBest = {
        raidId: "42",
        raidName: "Nerub-ar Palace",
        bossId: "1234",
        bossName: "Queen Ansurek",
        rankingsUrl:
          "https://www.warcraftlogs.com/character/eu/silvermoon/ryii#zone=42&boss=1234&difficulty=5",
        performance: {
          spec: null,
          damage: { state: "available" as const, percentile: 88 },
          healing: { state: "unavailable" as const },
          bossDamage: { state: "unavailable" as const }
        }
      };
      const cuttingEdge = {
        achievementId: "40254",
        completedAt: "2025-01-14T20:30:00.000Z"
      };

      // An ordinary collection that left a history cursor, a parse shortfall
      // and a retry deadline behind, and collected cutting edges.
      async function publishOrdinary() {
        const reservation = await repositories.evidence.reserve({
          key: rootKey,
          freshnessCutoff: ordinaryAt,
          at: ordinaryAt,
          phasePlan: ["blizzard_achievements", "publication"]
        });
        if (reservation.kind !== "reserved")
          throw new Error("evidence_not_reserved");
        await repositories.evidence.claim(reservation.run.id, 1);
        await repositories.evidence.recordPhaseTransitions?.(
          reservation.run.id,
          [
            {
              id: "blizzard_achievements",
              state: "active",
              startedAt: ordinaryAt,
              completedAt: null,
              limitationCode: null
            }
          ]
        );
        await repositories.evidence.recordPhaseTransitions?.(
          reservation.run.id,
          [
            {
              id: "blizzard_achievements",
              state: "completed",
              startedAt: ordinaryAt,
              completedAt: ordinaryAt,
              limitationCode: null
            }
          ]
        );
        await repositories.evidence.publish(reservation.run.id, {
          state: "partial",
          limitationCode: "request_cap",
          parseLimitationCode: "parse_request_cap",
          historyScanResumePage: 7,
          historyScanResumeBoundaryReportCode: "ordinaryBoundary",
          retryAfterAt: new Date("2026-09-22T12:30:00.000Z"),
          kills: [palace, nerubar],
          wipes: [storedWipe],
          tierBests: [storedBest],
          cuttingEdges: [cuttingEdge],
          completedAt: ordinaryAt
        });
        return reservation.run.id;
      }

      async function searchTier(at: Date) {
        const search = await repositories.evidence.reserveTierSearch({
          key: rootKey,
          raidId: "1179",
          at,
          searchedSince: new Date(at.getTime() - 24 * 60 * 60 * 1_000)
        });
        if (search.kind !== "reserved")
          throw new Error("tier_search_not_reserved");
        await repositories.evidence.claim(search.run.id, 1);
        return search.run.id;
      }

      const found = mythicKill({
        raidId: "23",
        raidName: "The Eternal Palace",
        bossId: "2298",
        bossName: "Za'qul",
        journalBossId: "2349",
        killedAt: "2019-08-20T20:00:00.000Z",
        reportUrl: "https://www.warcraftlogs.com/reports/palaceFound",
        fightUrl: "https://www.warcraftlogs.com/reports/palaceFound#fight=2"
      });
      const outcomes = [
        {
          name: "an empty complete search",
          publication: {
            state: "complete" as const,
            limitationCode: null,
            parseLimitationCode: null,
            scanSkipped: true,
            rankedBackfillCursor: null,
            kills: [],
            wipes: []
          },
          added: [] as string[]
        },
        {
          name: "a search that found a kill and a wipe",
          publication: {
            state: "complete" as const,
            limitationCode: null,
            parseLimitationCode: null,
            scanSkipped: true,
            rankedBackfillCursor: null,
            kills: [found],
            wipes: [
              mythicWipe({
                raidId: "23",
                raidName: "The Eternal Palace",
                fightUrl:
                  "https://www.warcraftlogs.com/reports/palaceFound#fight=1"
              })
            ]
          },
          added: [found.fightUrl]
        },
        {
          name: "a capped search awaiting its continuation",
          publication: {
            state: "partial" as const,
            limitationCode: "request_cap",
            parseLimitationCode: null,
            scanSkipped: true,
            retryAfterAt: new Date("2026-09-23T12:30:00.000Z"),
            kills: [],
            wipes: []
          },
          added: [] as string[]
        },
        {
          name: "a search stopped by a fault",
          publication: {
            state: "partial" as const,
            limitationCode: "collection_failed",
            parseLimitationCode: null,
            // A stopped attempt names no scan state; storage supplies it.
            retryAfterAt: new Date("2026-09-23T12:30:00.000Z"),
            kills: [],
            wipes: []
          },
          added: [] as string[]
        }
      ];

      it.each(outcomes)(
        "keeps every stored raid's evidence after $name",
        async ({ publication, added }) => {
          const ordinaryId = await publishOrdinary();
          const searchedAt = new Date("2026-09-23T12:00:00.000Z");
          const searchId = await searchTier(searchedAt);

          await repositories.evidence.publish(searchId, {
            ...publication,
            tierBests: [],
            // A targeted publication has none; any it offered is not stored.
            cuttingEdges: [
              {
                achievementId: "99999",
                completedAt: "2026-01-01T00:00:00.000Z"
              }
            ],
            historyScanResumePage: 1,
            historyScanResumeBoundaryReportCode: "searchBoundary",
            completedAt: searchedAt
          });

          const completed = await repositories.evidence.getCompleted(rootKey);
          // The snapshot is the search's, and holds everything there was.
          expect(completed?.kills.map((kill) => kill.fightUrl).sort()).toEqual(
            [palace.fightUrl, nerubar.fightUrl, ...added].sort()
          );
          expect(completed?.wipes.map((wipe) => wipe.fightUrl)).toEqual(
            expect.arrayContaining([storedWipe.fightUrl])
          );
          expect(completed?.tierBests).toEqual([
            expect.objectContaining({
              raidId: "42",
              performance: expect.objectContaining({
                damage: { state: "available", percentile: 88 }
              })
            })
          ]);
          // What the ordinary run last collected still speaks for itself:
          // when, with what shortfall, and the cutting edges.
          expect(completed?.run).toMatchObject({
            id: ordinaryId,
            status: "partial",
            limitationCode: "request_cap",
            parseLimitationCode: "parse_request_cap",
            completedAt: ordinaryAt,
            retryAfterAt: new Date("2026-09-22T12:30:00.000Z")
          });
          expect(completed?.cuttingEdgesCollected).toBe(true);
          expect(completed?.cuttingEdges).toEqual([cuttingEdge]);
          // The ordinary history cursor, scan turn and parse work are as the
          // ordinary run left them.
          await expect(
            repositories.evidence.storedEvidenceTiers(rootKey)
          ).resolves.toMatchObject({
            historyScanResumePage: 7,
            historyScanResumeBoundaryReportCode: "ordinaryBoundary",
            identityScanTurn: 1,
            parseWorkOutstanding: false
          });
          const row = await pool.query<{
            publication_scope: string;
            kill_scan_skipped: boolean;
            kill_scan_resume_page: number | null;
          }>(
            `SELECT publication_scope, kill_scan_skipped, kill_scan_resume_page
               FROM character_evidence_runs WHERE id = $1`,
            [searchId]
          );
          expect(row.rows[0]).toEqual({
            publication_scope: "tier",
            kill_scan_skipped: true,
            kill_scan_resume_page: null
          });
        }
      );

      it("marks read only the fights a targeted search publishes", async () => {
        // Break caught (#492 review): a search that parsed another raid's fight
        // on the same night restamped that stored, unparsed kill as read, so no
        // later run would parse it.
        await publishOrdinary();
        const searchedAt = new Date("2026-09-23T12:00:00.000Z");
        const searchId = await searchTier(searchedAt);

        await repositories.evidence.publish(searchId, {
          state: "complete",
          limitationCode: null,
          parseLimitationCode: null,
          scanSkipped: true,
          rankedBackfillCursor: null,
          kills: [found],
          wipes: [],
          tierBests: [],
          cuttingEdges: [],
          parsedFightUrls: [found.fightUrl, nerubar.fightUrl],
          completedAt: searchedAt
        });

        const rows = await pool.query<{
          fight_url: string;
          parses_read_at: Date | null;
        }>(
          `SELECT fight_url, parses_read_at FROM character_mythic_kills
            WHERE evidence_run_id = $1`,
          [searchId]
        );
        const readAt = new Map(
          rows.rows.map((row) => [row.fight_url, row.parses_read_at])
        );
        expect(readAt.get(found.fightUrl)).toEqual(searchedAt);
        expect(readAt.has(nerubar.fightUrl)).toBe(true);
        expect(readAt.get(nerubar.fightUrl)).toBeNull();
      });

      it("lets no targeted search refresh the ordinary evidence, or make it due", async () => {
        const ordinaryId = await publishOrdinary();
        // Settle the ordinary run, so only the search could make it due.
        await pool.query(
          `UPDATE character_evidence_runs SET retry_after_at = NULL WHERE id = $1`,
          [ordinaryId]
        );
        const searchedAt = new Date("2026-09-23T12:00:00.000Z");
        const searchId = await searchTier(searchedAt);
        await repositories.evidence.publish(searchId, {
          state: "partial",
          limitationCode: null,
          parseLimitationCode: "parse_request_cap",
          scanSkipped: true,
          retryAfterAt: new Date("2026-09-23T12:30:00.000Z"),
          kills: [found],
          wipes: [],
          tierBests: [],
          completedAt: searchedAt
        });

        // Its parse deadline is its own; no sweep resumes an ordinary run
        // for it.
        await expect(
          repositories.evidence.listResumable(
            10,
            new Date("2026-09-23T13:00:00.000Z")
          )
        ).resolves.toEqual([]);
        // Fresh by the search's clock, stale by the ordinary run's: stale.
        const reservation = await repositories.evidence.reserve({
          key: rootKey,
          freshnessCutoff: new Date("2026-09-23T00:00:00.000Z"),
          at: new Date("2026-09-23T13:00:00.000Z")
        });
        expect(reservation).toMatchObject({
          kind: "reserved",
          run: { mode: "full" },
          completed: { run: { id: ordinaryId } }
        });
        // The ordinary run that follows carries the search's kill forward.
        if (reservation.kind !== "reserved")
          throw new Error("evidence_not_reserved");
        await repositories.evidence.claim(reservation.run.id, 1);
        await repositories.evidence.publish(reservation.run.id, {
          state: "partial",
          limitationCode: "request_cap",
          parseLimitationCode: null,
          kills: [],
          wipes: [],
          tierBests: [],
          completedAt: new Date("2026-09-23T13:05:00.000Z")
        });
        expect(
          (await repositories.evidence.getCompleted(rootKey))?.kills.map(
            (kill) => kill.fightUrl
          )
        ).toEqual(expect.arrayContaining([found.fightUrl, palace.fightUrl]));
      });

      it("refuses a targeted scope on an ordinary run", async () => {
        const ordinaryId = await publishOrdinary();
        await expect(
          pool.query(
            `UPDATE character_evidence_runs SET publication_scope = 'tier'
              WHERE id = $1`,
            [ordinaryId]
          )
        ).rejects.toThrow(/character_evidence_runs_publication_scope_check/);
      });
    });

    it("never treats an ordinary run as a tier search", async () => {
      await expect(
        pool.query(
          `INSERT INTO character_evidence_runs
             (region, realm_slug, normalized_name, mode)
           VALUES ('eu', 'silvermoon', 'nobody', 'tier_search')`
        )
      ).rejects.toThrow(/character_evidence_runs_mode_check/);
    });
  });

  describe("attendance searches found empty (#434)", () => {
    const search = {
      at: "2020-01-21T19:34:00.000Z",
      guild: { name: "SeriouslyCasual", realm: "silvermoon", region: "eu" }
    };

    it("returns a search recorded within the window", async () => {
      const at = new Date("2026-09-23T12:00:00.000Z");
      await repositories.evidence.recordEmptyAttendanceSearches(
        rootKey,
        [search],
        at
      );

      await expect(
        repositories.evidence.emptyAttendanceSearches(
          rootKey,
          new Date("2026-09-16T12:00:00.000Z")
        )
      ).resolves.toEqual([search]);
      // Scoped to the character that searched.
      await expect(
        repositories.evidence.emptyAttendanceSearches(
          altKey,
          new Date("2026-09-16T12:00:00.000Z")
        )
      ).resolves.toEqual([]);
    });

    it("lets a search go stale, so its night is searched again", async () => {
      await repositories.evidence.recordEmptyAttendanceSearches(
        rootKey,
        [search],
        new Date("2026-09-01T12:00:00.000Z")
      );

      await expect(
        repositories.evidence.emptyAttendanceSearches(
          rootKey,
          new Date("2026-09-16T12:00:00.000Z")
        )
      ).resolves.toEqual([]);

      // Searching it again refreshes the one row rather than adding another.
      await repositories.evidence.recordEmptyAttendanceSearches(
        rootKey,
        [search],
        new Date("2026-09-23T12:00:00.000Z")
      );
      const rows = await pool.query(
        "SELECT searched_at FROM character_attendance_searches"
      );
      expect(rows.rows).toEqual([
        { searched_at: new Date("2026-09-23T12:00:00.000Z") }
      ]);
    });

    it("forgets a search made under an older kill collection", async () => {
      // A collection-version bump re-collects kills, and a night that held
      // nothing to the old decoder may hold something to the new one.
      await repositories.evidence.recordEmptyAttendanceSearches(
        rootKey,
        [search],
        new Date("2026-09-23T12:00:00.000Z")
      );
      await pool.query(
        "UPDATE character_attendance_searches SET collection_version = collection_version - 1"
      );

      await expect(
        repositories.evidence.emptyAttendanceSearches(
          rootKey,
          new Date("2026-09-16T12:00:00.000Z")
        )
      ).resolves.toEqual([]);
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
          guildAttendance: 4,
          reportHydration: 2,
          zoneRankings: 3,
          fightParses: 24,
          rankingIdentities: 1
        },
        recovery: {
          raiderIoOutcome: "evidence",
          raiderIoMs: 840,
          verifiedKillsSearched: 3,
          verifiedKillsSkippedEmpty: 1,
          recoveredKills: 1
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

    it("dates the newest published run whose Raider.IO lookup answered", async () => {
      // A stale dossier read goes light only while attendance recovery has
      // been asked recently (#540), so a lookup that failed, a run that never
      // asked, and a run that never published must not count.
      async function publishedRun(
        at: string,
        raiderIoOutcome: string | null
      ): Promise<void> {
        const runId = await reserveRun(rootKey, new Date(at));
        await repositories.evidence.recordRunCost(
          cost(runId, {
            recovery: { ...cost(runId).recovery, raiderIoOutcome }
          })
        );
        await repositories.evidence.publish(runId, {
          state: "complete",
          limitationCode: null,
          parseLimitationCode: null,
          kills: [],
          wipes: [],
          tierBests: [],
          completedAt: new Date(at)
        });
      }

      await expect(
        repositories.evidence.lastRaiderIoRecoveryAt(rootKey)
      ).resolves.toBeNull();

      await publishedRun("2026-09-10T12:00:00.000Z", "evidence");
      await publishedRun("2026-09-11T12:00:00.000Z", "unavailable");
      await publishedRun("2026-09-12T12:00:00.000Z", null);
      // Asked and answered, but never published.
      const unpublished = await reserveRun(
        rootKey,
        new Date("2026-09-13T12:00:00.000Z")
      );
      await repositories.evidence.recordRunCost(cost(unpublished));

      await expect(
        repositories.evidence.lastRaiderIoRecoveryAt(rootKey)
      ).resolves.toEqual(new Date("2026-09-10T12:00:00.000Z"));
      await expect(
        repositories.evidence.lastRaiderIoRecoveryAt(altKey)
      ).resolves.toBeNull();
    });

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
          ranking_identities_requests: 1,
          guild_attendance_requests: 4,
          report_hydration_requests: 2,
          raiderio_historic_outcome: "evidence",
          raiderio_historic_ms: 840,
          verified_kills_searched: 3,
          attendance_recovered_kills: 1,
          verified_kills_skipped_empty: 1
        })
      ]);
    });

    it("records a tier search apart, and leaves it null on a run that searched none", async () => {
      const ordinary = await reserveRun(rootKey, new Date());
      await repositories.evidence.recordRunCost(cost(ordinary));
      await pool.query(
        `UPDATE character_evidence_runs SET status = 'failed' WHERE id = $1`,
        [ordinary]
      );
      const searched = await reserveRun(rootKey, new Date());

      await repositories.evidence.recordRunCost(
        cost(searched, {
          mode: "tier_search",
          requests: { ...cost(searched).requests, characterGuilds: 1 },
          tierSearch: {
            raidId: "1180",
            outcome: "request_cap",
            requests: 40,
            guilds: 2,
            reportsHydrated: 12,
            recoveredKills: 3,
            recoveredWipes: 0
          }
        })
      );

      const recorded = await rows();
      expect(recorded.find((row) => row.run_id === ordinary)).toMatchObject({
        mode: "full",
        character_guilds_requests: 0,
        tier_search_raid_id: null,
        tier_search_outcome: null,
        tier_search_requests: null,
        tier_search_recovered_kills: null
      });
      expect(recorded.find((row) => row.run_id === searched)).toMatchObject({
        mode: "tier_search",
        character_guilds_requests: 1,
        tier_search_raid_id: "1180",
        tier_search_outcome: "request_cap",
        tier_search_requests: 40,
        tier_search_guilds: 2,
        tier_search_reports_hydrated: 12,
        tier_search_recovered_kills: 3,
        // Zero is a search that ran and found none, never a search not made.
        tier_search_recovered_wipes: 0
      });
    });

    it("records what Raider.IO and Blizzard cost, and zero for a run that asked neither", async () => {
      // A row from before these were counted reads null, which is not this:
      // a run that never asked Raider.IO or Blizzard spent nothing there.
      const silent = await reserveRun(rootKey, new Date());
      await repositories.evidence.recordRunCost(cost(silent));
      await pool.query(
        `UPDATE character_evidence_runs SET status = 'failed' WHERE id = $1`,
        [silent]
      );
      const asked = await reserveRun(rootKey, new Date());

      await repositories.evidence.recordRunCost(
        cost(asked, {
          requests: {
            ...cost(asked).requests,
            raiderIoHistoric: 17,
            raiderIoRankings: 6,
            blizzardAchievements: 1
          }
        })
      );

      const recorded = await rows();
      expect(recorded.find((row) => row.run_id === silent)).toMatchObject({
        raiderio_historic_requests: 0,
        raiderio_rankings_requests: 0,
        blizzard_achievements_requests: 0
      });
      expect(recorded.find((row) => row.run_id === asked)).toMatchObject({
        raiderio_historic_requests: 17,
        raiderio_rankings_requests: 6,
        blizzard_achievements_requests: 1
      });
    });

    it("records where the attempt's time went", async () => {
      const runId = await reserveRun(rootKey, new Date());

      await repositories.evidence.recordRunCost(
        cost(runId, {
          timings: {
            durationMs: 41_250,
            queueWaitMs: 0,
            warcraftLogsMs: 38_900,
            warcraftLogsHistoricAliasMs: 1_200,
            dbMs: 310,
            dbMaxCallName: "evidence.publish"
          }
        })
      );

      const [row] = await rows();
      expect(row).toMatchObject({
        duration_ms: 41_250,
        // Zero is a measured wait that was nothing, not an unmeasured one.
        queue_wait_ms: 0,
        warcraft_logs_ms: 38_900,
        warcraft_logs_historic_alias_ms: 1_200,
        db_ms: 310,
        db_max_call_name: "evidence.publish"
      });
    });

    it("keeps an unmeasured timing null rather than zero", async () => {
      // A job enqueued without a timestamp, or a bucket the attempt never
      // entered, was not measured. Averaging it in as zero would make runs
      // look faster than any of them were.
      const unmeasured = await reserveRun(rootKey, new Date());
      await repositories.evidence.recordRunCost(cost(unmeasured));
      await pool.query(
        `UPDATE character_evidence_runs SET status = 'failed' WHERE id = $1`,
        [unmeasured]
      );
      const partial = await reserveRun(rootKey, new Date());
      await repositories.evidence.recordRunCost(
        cost(partial, {
          timings: {
            durationMs: 900,
            queueWaitMs: null,
            warcraftLogsMs: null,
            warcraftLogsHistoricAliasMs: null,
            dbMs: 12,
            dbMaxCallName: null
          }
        })
      );

      const recorded = await rows();
      expect(recorded.find((row) => row.run_id === unmeasured)).toMatchObject({
        duration_ms: null,
        queue_wait_ms: null,
        warcraft_logs_ms: null,
        warcraft_logs_historic_alias_ms: null,
        db_ms: null,
        db_max_call_name: null
      });
      expect(recorded.find((row) => row.run_id === partial)).toMatchObject({
        duration_ms: 900,
        queue_wait_ms: null,
        warcraft_logs_ms: null,
        db_ms: 12,
        db_max_call_name: null
      });
    });

    it("keeps a recovery step that did not run null rather than zero", async () => {
      // Raider.IO not asked is not Raider.IO asked and answering with nothing
      // to search, and no attendance search is not one that recovered
      // nothing. Averaging the two together would misstate recovery's yield.
      const runId = await reserveRun(rootKey, new Date());

      await repositories.evidence.recordRunCost(
        cost(runId, {
          recovery: {
            raiderIoOutcome: null,
            raiderIoMs: null,
            verifiedKillsSearched: null,
            verifiedKillsSkippedEmpty: null,
            recoveredKills: null
          }
        })
      );

      const [row] = await rows();
      expect(row?.raiderio_historic_outcome).toBeNull();
      expect(row?.raiderio_historic_ms).toBeNull();
      expect(row?.verified_kills_searched).toBeNull();
      expect(row?.attendance_recovered_kills).toBeNull();
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
      // With timings, so the sweep is seen to take them too (#502).
      await repositories.evidence.recordRunCost(
        cost(oldRun, {
          timings: {
            durationMs: 1_000,
            queueWaitMs: 50,
            warcraftLogsMs: 800,
            warcraftLogsHistoricAliasMs: null,
            dbMs: 40,
            dbMaxCallName: "evidence.publish"
          }
        })
      );
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

      it("finds exactly the six queries the document describes", () => {
        expect(queries).toHaveLength(6);
      });

      it("reports where a run's time goes, apart from rows nothing timed", async () => {
        const untimed = await reserveRun(rootKey, new Date());
        const quick = await reserveRun(altKey, new Date());
        await repositories.evidence.recordRunCost(cost(untimed));
        await repositories.evidence.recordRunCost(
          cost(quick, {
            timings: {
              durationMs: 2_000,
              queueWaitMs: 100,
              warcraftLogsMs: 1_500,
              warcraftLogsHistoricAliasMs: null,
              dbMs: 60,
              dbMaxCallName: "evidence.publish"
            }
          })
        );

        const result = await pool.query(queries[5] as string);

        expect(result.rows).toEqual([
          expect.objectContaining({
            mode: "full",
            attempts: "2",
            measured: "1",
            // Over the timed row alone: the untimed one is not a zero.
            duration_p50_ms: "2000",
            duration_p95_ms: "2000",
            duration_max_ms: 2_000,
            queue_wait_p95_ms: "100",
            mean_warcraft_logs_ms: "1500",
            mean_db_ms: "60"
          })
        ]);
      });

      it("reports what Raider.IO and Blizzard cost, apart from rows nothing counted", async () => {
        const uncounted = await reserveRun(rootKey, new Date());
        const counted = await reserveRun(altKey, new Date());
        await repositories.evidence.recordRunCost(cost(uncounted));
        // What a row recorded before #298 looks like: nothing counted either
        // provider, which is not a run that asked neither.
        await pool.query(
          `UPDATE character_evidence_run_costs
           SET raiderio_historic_requests = NULL,
               raiderio_rankings_requests = NULL,
               blizzard_achievements_requests = NULL
           WHERE run_id = $1`,
          [uncounted]
        );
        await repositories.evidence.recordRunCost(
          cost(counted, {
            requests: {
              ...cost(counted).requests,
              raiderIoHistoric: 17,
              raiderIoRankings: 6,
              blizzardAchievements: 1
            }
          })
        );

        const result = await pool.query(queries[4] as string);

        expect(result.rows).toEqual([
          expect.objectContaining({
            mode: "full",
            attempts: "2",
            counted: "1",
            mean_raiderio_historic: "17.0",
            max_raiderio_historic: 17,
            mean_raiderio_rankings: "6.0",
            max_raiderio_rankings: 6,
            mean_blizzard: "1.0",
            max_blizzard: 1,
            // 12 + 4 + 2 + 3 + 24 + 1, over the counted row alone.
            mean_warcraft_logs: "46.0"
          })
        ]);
      });

      it("reports what tier searches spent and found, apart from other runs", async () => {
        const ordinary = await reserveRun(rootKey, new Date());
        const searched = await reserveRun(altKey, new Date());
        await repositories.evidence.recordRunCost(cost(ordinary));
        await repositories.evidence.recordRunCost(
          cost(searched, {
            mode: "tier_search",
            tierSearch: {
              raidId: "1180",
              outcome: "complete",
              requests: 20,
              guilds: 2,
              reportsHydrated: 11,
              recoveredKills: 1,
              recoveredWipes: 4
            }
          })
        );

        const result = await pool.query(queries[3] as string);

        expect(result.rows).toEqual([
          expect.objectContaining({
            tier_search_outcome: "complete",
            searches: "1",
            requests: "20",
            guilds: "2",
            reports_hydrated: "11",
            kills_recovered: "1",
            wipes_recovered: "4",
            measured: "1"
          })
        ]);
      });

      it("reports recovery's yield without counting an unasked run as zero", async () => {
        // Three attempts, one of each state: Raider.IO answered and a search
        // recovered a kill; Raider.IO refused; Raider.IO was never asked.
        const found = await reserveRun(rootKey, new Date());
        const refused = await reserveRun(altKey, new Date());
        await repositories.evidence.recordRunCost(cost(found));
        await repositories.evidence.recordRunCost(
          cost(found, {
            attempt: 2,
            requests: {
              historyScan: 12,
              guildAttendance: 0,
              reportHydration: 0,
              zoneRankings: 3,
              fightParses: 24,
              rankingIdentities: 1
            },
            recovery: {
              raiderIoOutcome: null,
              raiderIoMs: null,
              verifiedKillsSearched: null,
              verifiedKillsSkippedEmpty: null,
              recoveredKills: null
            }
          })
        );
        await repositories.evidence.recordRunCost(
          cost(refused, {
            recovery: {
              raiderIoOutcome: "private",
              raiderIoMs: 120,
              verifiedKillsSearched: 0,
              verifiedKillsSkippedEmpty: 0,
              recoveredKills: null
            }
          })
        );

        const result = await pool.query(queries[2] as string);
        const byOutcome = Object.fromEntries(
          result.rows.map((row) => [String(row.raiderio_historic_outcome), row])
        );

        expect(byOutcome.evidence).toMatchObject({
          attempts: "1",
          asked: "1",
          kills_searched: "3",
          kills_skipped_empty: "1",
          searches: "1",
          kills_recovered: "1",
          attendance_pages: "4",
          reports_hydrated: "2"
        });
        expect(byOutcome.private).toMatchObject({
          attempts: "1",
          asked: "1",
          kills_searched: "0",
          searches: "0"
        });
        // Never asked: counted as an attempt, and nothing else.
        expect(byOutcome.null).toMatchObject({
          attempts: "1",
          asked: "0",
          searches: "0",
          raiderio_p50_ms: null
        });
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
});
