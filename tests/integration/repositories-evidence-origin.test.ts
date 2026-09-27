import type { EvidenceRunCost } from "../../packages/database/src";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  altKey,
  resetRepositoryTables,
  rootKey,
  startRepositoryDatabase
} from "./repository-fixtures";
import type { TestRepositories } from "./test-repositories";

/**
 * Why each evidence run was queued (#708): recorded once, at reservation, on
 * the run itself, so nothing that re-claims or re-enqueues it can lose it.
 */
describe("PostgreSQL repositories: evidence run origin", () => {
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

  function cost(
    runId: string,
    attempt: number,
    origin?: EvidenceRunCost["origin"]
  ): EvidenceRunCost {
    return {
      runId,
      attempt,
      outcome: "complete",
      credentials: "own",
      limitationCode: null,
      parseLimitationCode: null,
      pointsSpent: 10,
      pointsLimitPerHour: 18_000,
      pointsRemainingBefore: 17_000,
      pointsRemainingAfter: 16_990,
      requestCapUsed: 300,
      parseRequestCapUsed: 24,
      ...(origin ? { origin } : {}),
      requests: {
        historyScan: 1,
        guildAttendance: 0,
        reportHydration: 0,
        zoneRankings: 0,
        fightParses: 0,
        rankingIdentities: 0
      },
      recovery: {
        raiderIoOutcome: null,
        raiderIoMs: null,
        verifiedKillsSearched: null,
        verifiedKillsSkippedEmpty: null,
        recoveredKills: null
      },
      tierSearch: null
    };
  }

  it("keeps the reserving path across a coalesced request, a re-claim and a re-enqueue", async () => {
    const at = new Date("2026-09-27T12:00:00.000Z");
    const reserved = await repositories.evidence.reserve({
      key: rootKey,
      origin: "applicant_sheet",
      freshnessCutoff: at,
      at
    });
    if (reserved.kind !== "reserved") throw new Error("evidence_not_reserved");
    expect(reserved.run.origin).toBe("applicant_sheet");

    // A second caller joins the run in flight. The run keeps the origin it
    // was reserved with; the joining caller's is not recorded.
    const joined = await repositories.evidence.reserve({
      key: rootKey,
      origin: "dossier_initial",
      freshnessCutoff: at,
      at
    });
    expect(joined).toMatchObject({
      kind: "active",
      run: { id: reserved.run.id, origin: "applicant_sheet" }
    });

    // A job re-enqueued carries only the run id, and a redelivery re-claims
    // the same row: neither has an origin to offer, so the row must hold it.
    await repositories.evidence.markEnqueued(reserved.run.id, "job-1");
    await expect(
      repositories.evidence.claim(reserved.run.id, 1)
    ).resolves.toMatchObject({ origin: "applicant_sheet" });
    await expect(
      repositories.evidence.claim(reserved.run.id, 2)
    ).resolves.toMatchObject({ origin: "applicant_sheet" });
    await expect(
      repositories.evidence.find(reserved.run.id)
    ).resolves.toMatchObject({ origin: "applicant_sheet" });
  });

  it("answers why the queue is long without another join", async () => {
    const at = new Date("2026-09-27T12:00:00.000Z");
    for (const [key, origin] of [
      [rootKey, "dossier_initial"],
      [altKey, "resume_sweep"]
    ] as const) {
      await repositories.evidence.reserve({
        key,
        origin,
        freshnessCutoff: at,
        at
      });
    }

    const queued = await pool.query<{ origin: string; count: string }>(
      `SELECT origin, count(*)::text AS count
         FROM character_evidence_runs
        WHERE status IN ('queued', 'running', 'retrying')
        GROUP BY 1 ORDER BY 1`
    );
    expect(queued.rows).toEqual([
      { origin: "dossier_initial", count: "1" },
      { origin: "resume_sweep", count: "1" }
    ]);
  });

  it("records a tier search as a tier search", async () => {
    const at = new Date("2026-09-27T12:00:00.000Z");
    const ordinary = await repositories.evidence.reserve({
      key: rootKey,
      origin: "dossier_read",
      freshnessCutoff: at,
      at
    });
    if (ordinary.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.claim(ordinary.run.id, 1);
    await repositories.evidence.publish(ordinary.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [],
      wipes: [],
      tierBests: [],
      completedAt: at
    });

    const search = await repositories.evidence.reserveTierSearch({
      key: rootKey,
      raidId: "42",
      at: new Date("2026-09-27T12:05:00.000Z"),
      searchedSince: new Date("2026-09-27T11:05:00.000Z")
    });

    expect(search).toMatchObject({
      kind: "reserved",
      run: { mode: "tier_search", origin: "tier_search" }
    });
  });

  it("carries the origin to the cost row and the collection monitor", async () => {
    const at = new Date("2026-09-27T12:00:00.000Z");
    const reserved = await repositories.evidence.reserve({
      key: rootKey,
      origin: "fingerprint_admission",
      freshnessCutoff: at,
      at
    });
    if (reserved.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.claim(reserved.run.id, 1);
    await repositories.evidence.recordRunCost(
      cost(reserved.run.id, 1, "fingerprint_admission")
    );
    // A caller that names no origin records `unknown`, never a guess.
    await repositories.evidence.recordRunCost(cost(reserved.run.id, 2));

    const costs = await pool.query<{ attempt: number; origin: string }>(
      `SELECT attempt, origin FROM character_evidence_run_costs
        WHERE run_id = $1 ORDER BY attempt`,
      [reserved.run.id]
    );
    expect(costs.rows).toEqual([
      { attempt: 1, origin: "fingerprint_admission" },
      { attempt: 2, origin: "unknown" }
    ]);

    await expect(
      repositories.evidence.listForMonitor({ completedLimit: 10 })
    ).resolves.toEqual([
      expect.objectContaining({ key: rootKey, origin: "fingerprint_admission" })
    ]);
  });

  it("reads a run from before origins as unknown and refuses free text", async () => {
    // What the migration leaves on every existing row: a class that says it
    // was not recorded, rather than a guess at the path that reserved it.
    const legacy = await pool.query<{ origin: string }>(
      `INSERT INTO character_evidence_runs (region, realm_slug, normalized_name)
       VALUES ($1, $2, $3) RETURNING origin`,
      [rootKey.region, rootKey.realm, rootKey.name]
    );
    expect(legacy.rows).toEqual([{ origin: "unknown" }]);

    // A class, never an identity: a request URL or referrer cannot be stored.
    await expect(
      pool.query(
        `INSERT INTO character_evidence_runs
           (region, realm_slug, normalized_name, origin)
         VALUES ($1, $2, $3, 'https://example.com/?ref=visitor')`,
        [altKey.region, altKey.realm, altKey.name]
      )
    ).rejects.toThrow(/character_evidence_runs_origin_check/);
  });
});
