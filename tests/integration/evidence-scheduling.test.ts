import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import type { Pool } from "pg";
import type { TestRepositories } from "./test-repositories";
import {
  mythicKill,
  rootKey,
  seedCompleteSnapshot,
  resetRepositoryTables,
  startRepositoryDatabase
} from "./repository-fixtures";

describe("metadata evidence scheduling", () => {
  let pool: Pool;
  let repositories: TestRepositories;
  let stop: () => Promise<void>;
  beforeAll(async () => {
    ({ pool, repositories, stop } = await startRepositoryDatabase());
  });
  beforeEach(async () => {
    await resetRepositoryTables(pool);
  });
  afterAll(async () => {
    await stop();
  });

  it("fixes light policy before a concurrent reader can repair the reservation", async () => {
    await seedCompleteSnapshot(repositories);
    const input = {
      key: rootKey,
      origin: "dossier_read" as const,
      at: new Date(),
      freshnessCutoff: new Date()
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let preparing = false;
    const owner = repositories.evidence.reserveForScheduling!(
      input,
      async () => {
        preparing = true;
        await held;
        return true;
      }
    );
    try {
      await vi.waitFor(() => expect(preparing).toBe(true));
      let joined = false;
      const reader = repositories.evidence.reserveForScheduling!(input).then(
        (result) => {
          joined = true;
          return result;
        }
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(joined).toBe(false);
      release();
      const [reserved, active] = await Promise.all([owner, reader]);
      expect(reserved).toMatchObject({
        kind: "reserved",
        run: { lightRefresh: true }
      });
      expect(active).toMatchObject({
        kind: "active",
        run: { id: reserved.run.id, lightRefresh: true }
      });
    } finally {
      release();
      await owner;
    }
  });

  it("honours pending alias recollection rather than treating old evidence as fresh", async () => {
    await seedCompleteSnapshot(repositories);
    const at = new Date("2026-10-13T12:00:00Z");
    const first = await repositories.evidence.reserve({
      key: rootKey,
      origin: "dossier_read",
      at,
      freshnessCutoff: at
    });
    await repositories.evidence.publish(first.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [],
      tierBests: [],
      completedAt: at
    });
    await repositories.evidence.addHistoricAlias!(rootKey, {
      ...rootKey,
      name: "former"
    });
    const scheduled = await repositories.evidence.reserveForScheduling!({
      key: rootKey,
      origin: "dossier_read",
      at,
      freshnessCutoff: new Date("2026-10-12T12:00:00Z")
    });
    expect(scheduled.kind).toBe("reserved");
    expect(scheduled.run.id).not.toBe(first.run.id);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS requests FROM character_alias_recollections"
        )
      ).rows
    ).toEqual([{ requests: 0 }]);
  });

  it("keeps a capped tier walk's deadline and resumes its targeted mode", async () => {
    await seedCompleteSnapshot(repositories);
    const at = new Date("2026-10-13T12:00:00Z");
    const first = await repositories.evidence.reserve({
      key: rootKey,
      origin: "dossier_read",
      at,
      freshnessCutoff: at
    });
    await repositories.evidence.publish(first.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [],
      tierBests: [],
      completedAt: at
    });
    const due = new Date(at.getTime() + 30 * 60_000);
    const targeted = await repositories.evidence.reserveTierSearch({
      key: rootKey,
      raidId: "1180",
      at,
      searchedSince: new Date(at.getTime() - 60_000)
    });
    if (targeted.kind !== "reserved")
      throw new Error("expected_tier_reservation");
    await repositories.evidence.publish(targeted.run.id, {
      state: "partial",
      limitationCode: "request_cap",
      parseLimitationCode: null,
      rankedBackfillCursor: {
        journalRaidId: "1180",
        characterId: 1234,
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
      },
      retryAfterAt: due,
      kills: [],
      wipes: [],
      tierBests: [],
      completedAt: new Date(at.getTime() + 1_000)
    });
    const waiting = await repositories.evidence.reserveForScheduling!({
      key: rootKey,
      origin: "dossier_read",
      at: new Date(at.getTime() + 5 * 60_000),
      freshnessCutoff: new Date(at.getTime() - 60_000)
    });
    expect(waiting).toMatchObject({ kind: "fresh", tierSearchResumesAt: due });
    expect(waiting.completed?.run.id).toBe(first.run.id);
    expect(waiting.completed?.snapshotRunId).toBe(targeted.run.id);
    const resumed = await repositories.evidence.reserveForScheduling!({
      key: rootKey,
      origin: "resume_sweep",
      at: due,
      freshnessCutoff: new Date(at.getTime() - 60_000)
    });
    expect(resumed).toMatchObject({
      kind: "reserved",
      run: {
        mode: "tier_search",
        tierSearchRaidId: "1180",
        origin: "resume_sweep"
      }
    });
  });

  it("joins the same locked reservation as full reserve and preserves its origin", async () => {
    await seedCompleteSnapshot(repositories);
    const input = {
      key: rootKey,
      origin: "refresh" as const,
      at: new Date(),
      freshnessCutoff: new Date(),
      phasePlan: ["blizzard_achievements"]
    };
    expect(repositories.evidence.reserveForScheduling).toBeTypeOf("function");
    const [metadata, full] = await Promise.all([
      repositories.evidence.reserveForScheduling!(input),
      repositories.evidence.reserve(input)
    ]);
    expect(metadata.run.id).toBe(full.run.id);
    expect([metadata.kind, full.kind].sort()).toEqual(["active", "reserved"]);
    expect(metadata.run.origin).toBe("refresh");
    expect(
      await repositories.evidence.listPhases!(metadata.run.id)
    ).toHaveLength(1);
  });

  it("reserves fresh evidence without reading locked payload tables and hydrates its chosen publication", async () => {
    await seedCompleteSnapshot(repositories);
    const at = new Date("2026-10-13T12:00:00Z");
    const first = await repositories.evidence.reserve({
      key: rootKey,
      origin: "dossier_read",
      at,
      freshnessCutoff: at
    });
    await repositories.evidence.publish(first.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [],
      tierBests: [],
      completedAt: at
    });
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "LOCK TABLE character_mythic_kills IN ACCESS EXCLUSIVE MODE"
    );
    try {
      expect(repositories.evidence.reserveForScheduling).toBeTypeOf("function");
      const metadata = await repositories.evidence.reserveForScheduling!({
        key: rootKey,
        origin: "dossier_read",
        at,
        freshnessCutoff: new Date("2026-10-12T12:00:00Z")
      });
      expect(metadata.kind).toBe("fresh");
      expect(metadata.completed).not.toHaveProperty("kills");
      await blocker.query("ROLLBACK");
      // Publication between scheduling and hydration must not change the
      // selected snapshot or turn old freshness into a new run's payload.
      const later = new Date(at.getTime() + 60 * 60_000);
      const next = await repositories.evidence.reserve({
        key: rootKey,
        origin: "refresh",
        at: later,
        freshnessCutoff: later
      });
      await repositories.evidence.publish(next.run.id, {
        state: "complete",
        limitationCode: null,
        parseLimitationCode: null,
        kills: [],
        wipes: [],
        tierBests: [],
        completedAt: later
      });
      const hydrated = await repositories.evidence.hydrateCompletedEvidence!(
        metadata.completed!
      );
      expect(hydrated.run.id).toBe(first.run.id);
      expect(hydrated.kills).toHaveLength(1);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });
});
