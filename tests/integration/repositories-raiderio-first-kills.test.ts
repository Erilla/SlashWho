import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  CharacterRaiderIoFirstKillInput,
  EvidenceRunCost,
  RaiderIoLoggedEncounterInput,
  RaiderIoLoggedEncounterMemberInput
} from "../../packages/database/src";
import {
  mythicKill,
  resetRepositoryTables,
  rootKey,
  startRepositoryDatabase
} from "./repository-fixtures";
import type { TestRepositories } from "./test-repositories";

// Synthetic identities throughout: this repository is public.
const killGuild = {
  name: "Fixture Guild Alfa",
  realm: "twisting-nether",
  region: "eu"
};
const alfa: RaiderIoLoggedEncounterMemberInput = {
  raiderIoCharacterId: 424_242,
  name: "Alfa",
  realm: "draenor",
  region: "eu",
  className: "Demon Hunter",
  specName: "Havoc",
  role: "dps",
  itemLevel: null
};
const bravo: RaiderIoLoggedEncounterMemberInput = {
  raiderIoCharacterId: 424_243,
  name: "Bravo",
  realm: "twisting-nether",
  region: "eu",
  className: "Warrior",
  specName: "Protection",
  role: "tank",
  itemLevel: 292.1
};
const encounter: RaiderIoLoggedEncounterInput = {
  loggedEncounterId: 700_001,
  raidSlug: "tier-mn-1",
  bossSlug: "midnight-falls",
  pulledAt: "2026-07-20T17:17:29.977Z",
  defeatedAt: "2026-07-20T17:25:57.301Z",
  durationMs: 507_324,
  guild: killGuild,
  itemLevel: { average: 290.312, min: 284.938, max: 293.062 },
  deathCount: 2,
  vantusCount: 16,
  rosterState: "available",
  members: [alfa, bravo]
};

function firstKill(
  overrides: Partial<CharacterRaiderIoFirstKillInput> = {}
): CharacterRaiderIoFirstKillInput {
  return {
    raidSlug: "tier-mn-1",
    bossSlug: "midnight-falls",
    killedAt: "2026-07-20T17:25:57.301Z",
    guild: killGuild,
    loggedEncounterId: 700_001,
    encounterState: "read",
    encounterLimitationCode: null,
    historicWorldRank: null,
    historicRankCheckedAt: "2026-09-28T12:00:00.000Z",
    ...overrides
  };
}

describe("PostgreSQL repositories: Raider.IO first kills", () => {
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

  async function reserve(at: string): Promise<string> {
    const reservation = await repositories.evidence.reserve({
      origin: "dossier_read",
      key: rootKey,
      freshnessCutoff: new Date(at),
      at: new Date(at)
    });
    if (reservation.kind !== "reserved")
      throw new Error("evidence_not_reserved");
    return reservation.run.id;
  }

  const save = (
    answers: Parameters<
      NonNullable<TestRepositories["evidence"]["saveRaiderIoLoggedEncounters"]>
    >[0],
    at: string
  ) =>
    repositories.evidence.saveRaiderIoLoggedEncounters!(answers, new Date(at));
  const stored = (ids: readonly number[]) =>
    repositories.evidence.raiderIoLoggedEncounters!(ids);

  async function publishFirstKill(): Promise<void> {
    const runId = await reserve("2026-09-28T12:00:00.000Z");
    await repositories.evidence.publish(runId, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [],
      wipes: [],
      tierBests: [],
      raiderIoFirstKills: {
        kills: [firstKill()],
        askedRaidSlugs: ["tier-mn-1"],
        limitationCode: null
      },
      completedAt: new Date("2026-09-28T12:05:00.000Z")
    });
  }

  it("keeps a visible roster as first read, however often it is read", async () => {
    await save(
      { encounters: [encounter], unavailable: [] },
      "2026-09-28T12:00:00.000Z"
    );
    await save(
      {
        encounters: [{ ...encounter, deathCount: 99, members: [] }],
        unavailable: []
      },
      "2026-09-29T12:00:00.000Z"
    );

    expect(await stored([700_001, 1])).toEqual({
      encounters: [{ ...encounter, readAt: "2026-09-28T12:00:00.000Z" }],
      unavailable: []
    });
  });

  it("replaces a hidden roster with a later read, dated by that read", async () => {
    await save(
      {
        encounters: [{ ...encounter, rosterState: "private", members: [] }],
        unavailable: []
      },
      "2026-09-01T12:00:00.000Z"
    );
    await save(
      { encounters: [encounter], unavailable: [] },
      "2026-09-28T12:00:00.000Z"
    );

    expect(await stored([700_001])).toEqual({
      encounters: [{ ...encounter, readAt: "2026-09-28T12:00:00.000Z" }],
      unavailable: []
    });
  });

  it("stores a permanent answer, and never lets one unread a kill", async () => {
    await save(
      {
        encounters: [encounter],
        unavailable: [{ loggedEncounterId: 700_002, code: "not_found" }]
      },
      "2026-09-01T12:00:00.000Z"
    );
    // A refusal refreshes a refusal, and never overwrites a read.
    await save(
      {
        encounters: [],
        unavailable: [
          { loggedEncounterId: 700_001, code: "not_found" },
          { loggedEncounterId: 700_002, code: "schema_drift" }
        ]
      },
      "2026-09-28T12:00:00.000Z"
    );

    expect(await stored([700_001, 700_002])).toEqual({
      encounters: [{ ...encounter, readAt: "2026-09-01T12:00:00.000Z" }],
      unavailable: [
        {
          loggedEncounterId: 700_002,
          code: "schema_drift",
          readAt: "2026-09-28T12:00:00.000Z"
        }
      ]
    });

    // A later read replaces a refusal.
    await save(
      {
        encounters: [{ ...encounter, loggedEncounterId: 700_002 }],
        unavailable: []
      },
      "2026-10-30T12:00:00.000Z"
    );
    expect((await stored([700_002])).unavailable).toEqual([]);
  });

  it("publishes first kills with the snapshot and shows each with its encounter", async () => {
    await save(
      { encounters: [encounter], unavailable: [] },
      "2026-09-28T12:00:00.000Z"
    );
    const runId = await reserve("2026-09-28T12:00:00.000Z");
    await repositories.evidence.publish(runId, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [],
      tierBests: [],
      raiderIoFirstKills: {
        kills: [
          firstKill(),
          firstKill({
            raidSlug: "manaforge-omega",
            bossSlug: "nexus-king-salhadaar",
            killedAt: "2025-09-10T20:00:00.000Z",
            loggedEncounterId: null,
            encounterState: "unavailable",
            historicRankCheckedAt: null
          })
        ],
        askedRaidSlugs: ["tier-mn-1", "manaforge-omega"],
        limitationCode: null
      },
      completedAt: new Date("2026-09-28T12:05:00.000Z")
    });

    const completed = await repositories.evidence.getCompleted(rootKey);
    expect(completed?.raiderIoFirstKills).toEqual([
      {
        ...firstKill({
          raidSlug: "manaforge-omega",
          bossSlug: "nexus-king-salhadaar",
          killedAt: "2025-09-10T20:00:00.000Z",
          loggedEncounterId: null,
          encounterState: "unavailable",
          historicRankCheckedAt: null
        }),
        encounter: null
      },
      {
        ...firstKill(),
        encounter: {
          ...encounter,
          readAt: "2026-09-28T12:00:00.000Z",
          roleCounts: { tank: 1, healer: 0, dps: 1 }
        }
      }
    ]);
    expect(
      await repositories.evidence.storedRaiderIoFirstKills!(rootKey)
    ).toHaveLength(2);
  });

  it("leaves a suppressed raider off the roster a dossier reads, and still counts them", async () => {
    // Break caught (#734 review): a removed character who raided with the
    // kill guild would be named, with realm, class and item level, on the
    // dossier of everyone who shared the kill.
    await save(
      { encounters: [encounter], unavailable: [] },
      "2026-09-28T12:00:00.000Z"
    );
    await publishFirstKill();
    await repositories.suppressions.suppress(
      { region: "eu", realm: "twisting-nether", name: "bravo" },
      "github-issue-1",
      null
    );

    const completed = await repositories.evidence.getCompleted(rootKey);
    expect(completed?.raiderIoFirstKills?.[0]?.encounter).toMatchObject({
      members: [alfa],
      roleCounts: { tank: 1, healer: 0, dps: 1 }
    });
    // Collection's presence check still sees the whole roster, and the row
    // is kept: removal suppresses reads, it does not delete.
    expect((await stored([700_001])).encounters[0]?.members).toEqual([
      alfa,
      bravo
    ]);
    const rows = await pool.query(
      "SELECT count(*)::int AS count FROM raiderio_logged_encounter_members"
    );
    expect(rows.rows[0]).toEqual({ count: 2 });
  });

  it("shows the raider again once the suppression expires", async () => {
    await save(
      { encounters: [encounter], unavailable: [] },
      "2026-09-28T12:00:00.000Z"
    );
    await publishFirstKill();
    await repositories.suppressions.suppress(
      { region: "eu", realm: "twisting-nether", name: "bravo" },
      "github-issue-1",
      new Date(Date.now() - 60_000)
    );

    const completed = await repositories.evidence.getCompleted(rootKey);
    expect(completed?.raiderIoFirstKills?.[0]?.encounter?.members).toEqual([
      alfa,
      bravo
    ]);
  });

  it("carries first kills forward through a run that did not read them, and drops them only where a complete run looked", async () => {
    const publish = async (
      runId: string,
      completedAt: string,
      raiderIoFirstKills?: Parameters<
        TestRepositories["evidence"]["publish"]
      >[1]["raiderIoFirstKills"]
    ) =>
      repositories.evidence.publish(runId, {
        state: "complete",
        limitationCode: null,
        parseLimitationCode: null,
        kills: [],
        wipes: [],
        tierBests: [],
        ...(raiderIoFirstKills ? { raiderIoFirstKills } : {}),
        completedAt: new Date(completedAt)
      });
    const queenAnsurek = firstKill({
      raidSlug: "nerubar-palace",
      bossSlug: "queen-ansurek",
      killedAt: "2024-10-01T20:00:00.000Z",
      loggedEncounterId: 1_234,
      encounterState: "unavailable",
      encounterLimitationCode: "not_found"
    });

    await publish(
      await reserve("2026-09-01T12:00:00.000Z"),
      "2026-09-01T12:05:00.000Z",
      {
        kills: [firstKill(), queenAnsurek],
        askedRaidSlugs: ["tier-mn-1", "nerubar-palace"],
        limitationCode: null
      }
    );
    await publish(
      await reserve("2026-09-02T12:00:00.000Z"),
      "2026-09-02T12:05:00.000Z"
    );
    expect(
      (await repositories.evidence.storedRaiderIoFirstKills!(rootKey)).map(
        (kill) => kill.bossSlug
      )
    ).toEqual(["queen-ansurek", "midnight-falls"]);

    await publish(
      await reserve("2026-09-03T12:00:00.000Z"),
      "2026-09-03T12:05:00.000Z",
      {
        kills: [],
        askedRaidSlugs: ["tier-mn-1"],
        limitationCode: null
      }
    );
    expect(
      (await repositories.evidence.storedRaiderIoFirstKills!(rootKey)).map(
        (kill) => kill.bossSlug
      )
    ).toEqual(["queen-ansurek"]);
  });

  it("accepts a run partial only for its Raider.IO shortfall, and says so", async () => {
    const runId = await reserve("2026-09-28T12:00:00.000Z");
    await repositories.evidence.publish(runId, {
      state: "partial",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [],
      wipes: [],
      tierBests: [],
      raiderIoFirstKills: {
        kills: [
          firstKill({
            encounterState: "unavailable",
            encounterLimitationCode: "request_cap"
          })
        ],
        askedRaidSlugs: ["tier-mn-1"],
        limitationCode: "request_cap"
      },
      completedAt: new Date("2026-09-28T12:05:00.000Z")
    });

    const completed = await repositories.evidence.getCompleted(rootKey);
    expect(completed?.run).toMatchObject({
      status: "partial",
      raiderIoLimitationCode: "request_cap"
    });
    expect(completed?.run).not.toHaveProperty("killScanSkipped");
  });

  it("loads a skipped kill scan onto the run", async () => {
    const runId = await reserve("2026-09-28T12:00:00.000Z");
    await repositories.evidence.publish(runId, {
      state: "partial",
      limitationCode: null,
      parseLimitationCode: null,
      scanSkipped: true,
      kills: [],
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-09-28T12:05:00.000Z")
    });

    expect(
      (await repositories.evidence.getCompleted(rootKey))?.run
    ).toMatchObject({ status: "partial", killScanSkipped: true });
  });

  it("still refuses a partial run that names no shortfall at all", async () => {
    const runId = await reserve("2026-09-28T12:00:00.000Z");
    await expect(
      repositories.evidence.publish(runId, {
        state: "partial",
        limitationCode: null,
        parseLimitationCode: null,
        kills: [],
        wipes: [],
        tierBests: [],
        raiderIoFirstKills: {
          kills: [],
          askedRaidSlugs: [],
          limitationCode: null
        },
        completedAt: new Date("2026-09-28T12:05:00.000Z")
      })
    ).rejects.toThrow("character_evidence_publication_invalid");
  });

  it("records the logged-encounter reads on the run's cost row", async () => {
    const runId = await reserve("2026-09-28T12:00:00.000Z");
    const cost: EvidenceRunCost = {
      runId,
      attempt: 1,
      outcome: "published",
      credentials: "own",
      limitationCode: null,
      parseLimitationCode: null,
      pointsSpent: 10,
      pointsLimitPerHour: 18_000,
      pointsRemainingBefore: 17_000,
      pointsRemainingAfter: 16_990,
      requestCapUsed: 300,
      parseRequestCapUsed: 24,
      requests: {
        historyScan: 1,
        guildAttendance: 0,
        reportHydration: 0,
        zoneRankings: 0,
        fightParses: 0,
        rankingIdentities: 0,
        raiderIoHistoric: 18,
        raiderIoLoggedEncounters: 7
      },
      recovery: {
        raiderIoOutcome: "evidence",
        raiderIoMs: 100,
        verifiedKillsSearched: 0,
        verifiedKillsSkippedEmpty: 0,
        recoveredKills: 0
      }
    };

    await repositories.evidence.recordRunCost(cost);

    const rows = await pool.query(
      `SELECT raiderio_historic_requests, raiderio_logged_encounter_requests
         FROM character_evidence_run_costs WHERE run_id = $1`,
      [runId]
    );
    expect(rows.rows).toEqual([
      {
        raiderio_historic_requests: 18,
        raiderio_logged_encounter_requests: 7
      }
    ]);
  });

  it("never publishes a run's kills without its Raider.IO first kills", async () => {
    // Break caught: first kills written after the run was marked complete
    // would let a reader see a snapshot with half its evidence.
    await pool.query(`
      CREATE FUNCTION reject_raiderio_first_kill() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'raiderio_first_kill_rejected'; END $$;
      CREATE TRIGGER reject_raiderio_first_kill
        BEFORE INSERT ON character_raiderio_first_kills
        FOR EACH ROW EXECUTE FUNCTION reject_raiderio_first_kill();
    `);
    try {
      const runId = await reserve("2026-09-28T12:00:00.000Z");
      await expect(
        repositories.evidence.publish(runId, {
          state: "complete",
          limitationCode: null,
          parseLimitationCode: null,
          kills: [mythicKill()],
          wipes: [],
          tierBests: [],
          raiderIoFirstKills: {
            kills: [
              firstKill({
                encounterState: "unavailable",
                encounterLimitationCode: "request_cap"
              })
            ],
            askedRaidSlugs: ["tier-mn-1"],
            limitationCode: null
          },
          completedAt: new Date("2026-09-28T12:05:00.000Z")
        })
      ).rejects.toThrow("raiderio_first_kill_rejected");

      const kills = await pool.query(
        "SELECT count(*)::int AS count FROM character_mythic_kills WHERE evidence_run_id = $1",
        [runId]
      );
      expect(kills.rows[0]).toEqual({ count: 0 });
      expect(await repositories.evidence.getCompleted(rootKey)).toBeNull();
      expect((await repositories.evidence.find(runId))?.status).toBe("queued");
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS reject_raiderio_first_kill ON character_raiderio_first_kills;
        DROP FUNCTION IF EXISTS reject_raiderio_first_kill();
      `);
    }
  });
});
