import type { CharacterKey } from "@slashwho/domain";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  observation,
  resetRepositoryTables,
  rootKey,
  altKey,
  startRepositoryDatabase
} from "./repository-fixtures";
import type { TestRepositories } from "./test-repositories";

const thirdKey = { region: "eu", realm: "draenor", name: "third" } as const;
const eKey = { region: "eu", realm: "draenor", name: "eve" } as const;

describe("character connections: observation writes", () => {
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

  async function publishedRun(
    characters = [
      observation(rootKey, "Ryii"),
      observation(altKey, "Alt", "claimed"),
      observation(thirdKey, "Third", "claimed")
    ]
  ) {
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await repositories.runs.markRunning(run.id);
    await repositories.snapshots.create({
      runId: run.id,
      rootKey,
      state: "complete",
      limitationCode: null,
      refreshedAt: new Date(),
      characters
    });
    return run.id;
  }

  /** Like `publishedRun`, but for an arbitrary root: a second observer. */
  async function publishedRunFor(
    root: CharacterKey,
    characters: ReturnType<typeof observation>[]
  ): Promise<string> {
    const run = await repositories.runs.createOrReuse(root, "anonymous");
    await repositories.runs.markRunning(run.id);
    await repositories.snapshots.create({
      runId: run.id,
      rootKey: root,
      state: "complete",
      limitationCode: null,
      refreshedAt: new Date(),
      characters
    });
    return run.id;
  }

  async function characterId(key: CharacterKey): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM characters
       WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
      [key.region, key.realm, key.name]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error(`no character row for ${JSON.stringify(key)}`);
    return id;
  }

  const connections = () => repositories.characterConnections!;

  it("records each observation, the marker and one ledger row per family", async () => {
    const runId = await publishedRun();
    const result = await connections().writeObservations({
      runId,
      observerKey: rootKey,
      families: [
        {
          family: "raiderio",
          decision: "replaced",
          reason: "raiderio_complete",
          sweepReservationId: null,
          observed: [
            { key: altKey, source: "claimed" },
            { key: thirdKey, source: "claimed" }
          ]
        }
      ]
    });
    expect(result.unknownCharacters).toBe(0);
    const rows = await pool.query(
      `SELECT source, kind FROM character_connections ORDER BY source`
    );
    expect(rows.rows).toEqual([
      { source: "claimed", kind: "observed" },
      { source: "claimed", kind: "observed" }
    ]);
    const ledger = await pool.query(
      `SELECT family, decision, reason FROM character_connection_write_log`
    );
    expect(ledger.rows).toEqual([
      { family: "raiderio", decision: "replaced", reason: "raiderio_complete" }
    ]);
    const marker = await pool.query(
      `SELECT family, run_id FROM character_connection_writes`
    );
    expect(marker.rows).toEqual([{ family: "raiderio", run_id: runId }]);
  });

  it("stamps the ledger row when it is inserted, not when its transaction began", async () => {
    // Break caught: `written_at` defaulted to the transaction's start, so a
    // writer that waited on its locks logged a time up to 10 s before its
    // commit, past the replay's 5 s clock tolerance.
    const runId = await publishedRun();
    const hold = await pool.connect();
    let released: Date;
    let write: Promise<unknown>;
    try {
      await hold.query("BEGIN");
      await hold.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`root:${rootKey.region}:${rootKey.realm}:${rootKey.name}`]
      );
      write = connections().writeObservations({
        runId,
        observerKey: rootKey,
        families: [
          {
            family: "raiderio",
            decision: "added_only",
            reason: "raiderio_limited",
            sweepReservationId: null,
            observed: [{ key: altKey, source: "claimed" }]
          }
        ]
      });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      released = (
        await hold.query<{ at: Date }>(`SELECT clock_timestamp() AS at`)
      ).rows[0]!.at;
      await hold.query("COMMIT");
    } finally {
      hold.release();
    }
    await write;
    const ledger = await pool.query<{ written_at: Date }>(
      `SELECT written_at FROM character_connection_write_log WHERE run_id = $1`,
      [runId]
    );
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]!.written_at.getTime()).toBeGreaterThanOrEqual(
      released.getTime()
    );
  });

  it("records both sources before de-duplication", async () => {
    // Break caught: de-duplicated input stored a character both sources found
    // as Raider.IO only, and presence failed for its fingerprint link.
    const runId = await publishedRun();
    await connections().writeObservations({
      runId,
      observerKey: rootKey,
      families: [
        {
          family: "raiderio",
          decision: "added_only",
          reason: "raiderio_limited",
          sweepReservationId: null,
          observed: [{ key: altKey, source: "claimed" }]
        },
        {
          family: "fingerprint",
          decision: "added_only",
          reason: "capped",
          sweepReservationId: null,
          observed: [{ key: altKey, source: "fingerprint" }]
        }
      ]
    });
    const rows = await pool.query(
      `SELECT source FROM character_connections ORDER BY source`
    );
    expect(rows.rows.map((row) => row.source)).toEqual([
      "claimed",
      "fingerprint"
    ]);
  });

  it("retracts only the family it replaces, and only rows older than the run", async () => {
    const first = await publishedRun();
    await connections().writeObservations({
      runId: first,
      observerKey: rootKey,
      families: [
        {
          family: "raiderio",
          decision: "replaced",
          reason: "raiderio_complete",
          sweepReservationId: null,
          observed: [
            { key: altKey, source: "claimed" },
            { key: thirdKey, source: "claimed" }
          ]
        },
        {
          family: "fingerprint",
          decision: "replaced",
          reason: "matched",
          sweepReservationId: null,
          observed: [{ key: thirdKey, source: "fingerprint" }]
        }
      ]
    });
    const second = await publishedRun([
      observation(rootKey, "Ryii"),
      observation(altKey, "Alt", "claimed")
    ]);
    await connections().writeObservations({
      runId: second,
      observerKey: rootKey,
      families: [
        {
          family: "raiderio",
          decision: "replaced",
          reason: "raiderio_complete",
          sweepReservationId: null,
          observed: [{ key: altKey, source: "claimed" }]
        }
      ]
    });
    const rows = await pool.query(
      `SELECT source, discovery_run_id FROM character_connections ORDER BY source`
    );
    // third's claimed link is retracted; its fingerprint link is another family.
    expect(rows.rows).toEqual([
      { source: "claimed", discovery_run_id: second },
      { source: "fingerprint", discovery_run_id: first }
    ]);
  });

  it("blocks a delayed continuation after a newer sweep chain has written", async () => {
    // Break caught: a continuation committing late re-added links a newer
    // chain had retracted, and its seal could cut the newer chain's links.
    const older = await publishedRun();
    await pool.query(
      `UPDATE discovery_runs SET started_at = now() - interval '2 hours' WHERE id = $1`,
      [older]
    );
    const newer = await publishedRun([observation(rootKey, "Ryii")]);
    await connections().writeObservations({
      runId: newer,
      observerKey: rootKey,
      families: [
        {
          family: "fingerprint",
          decision: "replaced",
          reason: "matched",
          sweepReservationId: null,
          observed: []
        }
      ]
    });
    await connections().writeObservations({
      runId: older,
      observerKey: rootKey,
      families: [
        {
          family: "fingerprint",
          decision: "added_only",
          reason: "capped",
          sweepReservationId: null,
          observed: [{ key: altKey, source: "fingerprint" }]
        }
      ]
    });
    expect(
      (await pool.query(`SELECT 1 FROM character_connections`)).rowCount
    ).toBe(0);
    const ledger = await pool.query(
      `SELECT run_id, decision, reason FROM character_connection_write_log ORDER BY id`
    );
    expect(ledger.rows).toEqual([
      { run_id: newer, decision: "replaced", reason: "matched" },
      { run_id: older, decision: "blocked", reason: "blocked_by_newer" }
    ]);
  });

  it("keeps a chain's seal from retracting after an earlier cycle skipped a guild", async () => {
    // Break caught: a 404'd historical guild in a capped cycle was forgotten
    // at the seal, whose `replaced` retracted links the chain never re-read.
    const fingerprintWrite = (
      decision: "added_only" | "replaced",
      reason: "skipped_guild" | "matched",
      observed: { key: CharacterKey; source: "fingerprint" }[]
    ) => ({
      family: "fingerprint" as const,
      decision,
      reason,
      sweepReservationId: null,
      observed
    });
    const earlier = await publishedRun();
    await connections().writeObservations({
      runId: earlier,
      observerKey: rootKey,
      families: [
        fingerprintWrite("replaced", "matched", [
          { key: thirdKey, source: "fingerprint" }
        ])
      ]
    });
    const chain = await publishedRun();
    await connections().writeObservations({
      runId: chain,
      observerKey: rootKey,
      families: [
        fingerprintWrite("added_only", "skipped_guild", [
          { key: altKey, source: "fingerprint" }
        ])
      ]
    });
    await connections().writeObservations({
      runId: chain,
      observerKey: rootKey,
      families: [fingerprintWrite("replaced", "matched", [])]
    });

    const links = async () =>
      (
        await pool.query<{ discovery_run_id: string }>(
          `SELECT discovery_run_id FROM character_connections
            WHERE source = 'fingerprint' ORDER BY discovery_run_id`
        )
      ).rows.map((row) => row.discovery_run_id);
    expect(await links()).toEqual([earlier, chain].sort());
    const ledger = async (runId: string) =>
      (
        await pool.query(
          `SELECT decision, reason FROM character_connection_write_log
            WHERE run_id = $1 ORDER BY id`,
          [runId]
        )
      ).rows;
    expect(await ledger(chain)).toEqual([
      { decision: "added_only", reason: "skipped_guild" },
      { decision: "added_only", reason: "skipped_guild" }
    ]);

    // A separate run carries no skip of its own, so its match still replaces.
    const later = await publishedRun();
    await connections().writeObservations({
      runId: later,
      observerKey: rootKey,
      families: [fingerprintWrite("replaced", "matched", [])]
    });
    expect(await links()).toEqual([]);
    expect(await ledger(later)).toEqual([
      { decision: "replaced", reason: "matched" }
    ]);
  });

  it("never lowers observed_at", async () => {
    const runId = await publishedRun();
    const write = {
      runId,
      observerKey: rootKey,
      families: [
        {
          family: "raiderio" as const,
          decision: "added_only" as const,
          reason: "raiderio_limited" as const,
          sweepReservationId: null,
          observed: [{ key: altKey, source: "claimed" as const }]
        }
      ]
    };
    await connections().writeObservations(write);
    await pool.query(
      `UPDATE character_connections SET observed_at = now() + interval '1 day'`
    );
    await connections().writeObservations(write);
    const rows = await pool.query<{ ahead: boolean }>(
      `SELECT observed_at > now() AS ahead FROM character_connections`
    );
    expect(rows.rows[0]!.ahead).toBe(true);
  });

  it("skips keys with no character row and counts them", async () => {
    const runId = await publishedRun();
    const result = await connections().writeObservations({
      runId,
      observerKey: rootKey,
      families: [
        {
          family: "raiderio",
          decision: "added_only",
          reason: "live_sweep_completion",
          sweepReservationId: null,
          observed: [
            {
              key: { region: "eu", realm: "draenor", name: "nobody" },
              source: "claimed"
            }
          ]
        }
      ]
    });
    expect(result.unknownCharacters).toBe(1);
    expect(
      (
        await pool.query(
          `SELECT 1 FROM characters WHERE normalized_name = 'nobody'`
        )
      ).rowCount
    ).toBe(0);
  });

  it("touches no existing table (P2)", async () => {
    const runId = await publishedRun();
    const before = await existingChecksum(pool);
    await connections().writeObservations({
      runId,
      observerKey: rootKey,
      families: [
        {
          family: "raiderio",
          decision: "replaced",
          reason: "raiderio_complete",
          sweepReservationId: null,
          observed: [{ key: altKey, source: "claimed" }]
        }
      ]
    });
    expect(await existingChecksum(pool)).toBe(before);
  });

  describe("retraction bounds", () => {
    it("keeps a row an observed_at bound alone would not protect, because it is newer than the retracting run", async () => {
      // R1's own started_at is pinned far in the past, so R1's write does not
      // block R2 later. R1's row then carries an observed_at from write time
      // (now), which sits at or after R2's started_at once that is pinned
      // between the two. The discovery_run_id clause alone would not protect
      // this row (R1 !== R2): only `observed_at < run_started_at` does.
      const r1 = await publishedRun();
      await pool.query(
        `UPDATE discovery_runs SET started_at = now() - interval '2 hours' WHERE id = $1`,
        [r1]
      );
      await connections().writeObservations({
        runId: r1,
        observerKey: rootKey,
        families: [
          {
            family: "raiderio",
            decision: "added_only",
            reason: "raiderio_limited",
            sweepReservationId: null,
            observed: [{ key: altKey, source: "claimed" }]
          }
        ]
      });

      const r2 = await publishedRun();
      await pool.query(
        `UPDATE discovery_runs SET started_at = now() - interval '1 hour' WHERE id = $1`,
        [r2]
      );
      await connections().writeObservations({
        runId: r2,
        observerKey: rootKey,
        families: [
          {
            family: "raiderio",
            decision: "replaced",
            reason: "raiderio_complete",
            sweepReservationId: null,
            observed: []
          }
        ]
      });

      const rows = await pool.query(
        `SELECT source, discovery_run_id FROM character_connections`
      );
      expect(rows.rows).toEqual([{ source: "claimed", discovery_run_id: r1 }]);
    });

    it("keeps a same-run row even with an artificially old observed_at, because a discovery_run_id bound alone would not protect it", async () => {
      // The row's observed_at is forced far into the past, well before this
      // run's own started_at, so the observed_at bound alone would delete
      // it. Only `discovery_run_id <> $current_run` protects a row this same
      // run continuation itself re-observed.
      const runId = await publishedRun();
      await connections().writeObservations({
        runId,
        observerKey: rootKey,
        families: [
          {
            family: "raiderio",
            decision: "added_only",
            reason: "raiderio_limited",
            sweepReservationId: null,
            observed: [{ key: altKey, source: "claimed" }]
          }
        ]
      });
      await pool.query(
        `UPDATE character_connections SET observed_at = now() - interval '2 hours'`
      );
      await connections().writeObservations({
        runId,
        observerKey: rootKey,
        families: [
          {
            family: "raiderio",
            decision: "replaced",
            reason: "raiderio_complete",
            sweepReservationId: null,
            observed: []
          }
        ]
      });
      const rows = await pool.query(
        `SELECT source, discovery_run_id FROM character_connections`
      );
      expect(rows.rows).toEqual([
        { source: "claimed", discovery_run_id: runId }
      ]);
    });
  });

  it("a second observer's row for the same other character survives the first observer's replaced write", async () => {
    const first = await publishedRun();
    await connections().writeObservations({
      runId: first,
      observerKey: rootKey,
      families: [
        {
          family: "raiderio",
          decision: "replaced",
          reason: "raiderio_complete",
          sweepReservationId: null,
          observed: [{ key: thirdKey, source: "claimed" }]
        }
      ]
    });

    const altRun = await publishedRunFor(altKey, [
      observation(altKey, "Alt"),
      observation(thirdKey, "Third", "claimed")
    ]);
    await connections().writeObservations({
      runId: altRun,
      observerKey: altKey,
      families: [
        {
          family: "raiderio",
          decision: "replaced",
          reason: "raiderio_complete",
          sweepReservationId: null,
          observed: [{ key: thirdKey, source: "claimed" }]
        }
      ]
    });

    const second = await publishedRun([observation(rootKey, "Ryii")]);
    await connections().writeObservations({
      runId: second,
      observerKey: rootKey,
      families: [
        {
          family: "raiderio",
          decision: "replaced",
          reason: "raiderio_complete",
          sweepReservationId: null,
          observed: []
        }
      ]
    });

    const altId = await characterId(altKey);
    const rows = await pool.query(
      `SELECT observed_from_character_id FROM character_connections`
    );
    expect(rows.rows).toEqual([{ observed_from_character_id: altId }]);
  });

  describe("changedCharacterIds", () => {
    it("contains both ends of a newly inserted link, both ends of a retracted link, and the observer", async () => {
      const first = await publishedRun();
      const observerId = await characterId(rootKey);
      const altId = await characterId(altKey);
      const thirdId = await characterId(thirdKey);

      await connections().writeObservations({
        runId: first,
        observerKey: rootKey,
        families: [
          {
            family: "raiderio",
            decision: "replaced",
            reason: "raiderio_complete",
            sweepReservationId: null,
            observed: [{ key: altKey, source: "claimed" }]
          }
        ]
      });

      const second = await publishedRun();
      const result = await connections().writeObservations({
        runId: second,
        observerKey: rootKey,
        families: [
          {
            family: "raiderio",
            decision: "replaced",
            reason: "raiderio_complete",
            sweepReservationId: null,
            observed: [{ key: thirdKey, source: "claimed" }]
          }
        ]
      });

      expect([...result.changedCharacterIds].sort()).toEqual(
        [observerId, altId, thirdId].sort()
      );
    });

    it("is exactly the observer when the only family is blocked", async () => {
      const older = await publishedRun();
      const observerId = await characterId(rootKey);
      await pool.query(
        `UPDATE discovery_runs SET started_at = now() - interval '2 hours' WHERE id = $1`,
        [older]
      );
      const newer = await publishedRun([observation(rootKey, "Ryii")]);
      await connections().writeObservations({
        runId: newer,
        observerKey: rootKey,
        families: [
          {
            family: "fingerprint",
            decision: "replaced",
            reason: "matched",
            sweepReservationId: null,
            observed: []
          }
        ]
      });

      const result = await connections().writeObservations({
        runId: older,
        observerKey: rootKey,
        families: [
          {
            family: "fingerprint",
            decision: "added_only",
            reason: "capped",
            sweepReservationId: null,
            observed: [{ key: altKey, source: "fingerprint" }]
          }
        ]
      });

      expect(result.changedCharacterIds).toEqual([observerId]);
    });

    it("adds no new ids beyond the observer when a repeat write only renews observed_at", async () => {
      const runId = await publishedRun();
      const observerId = await characterId(rootKey);
      const altId = await characterId(altKey);
      const write = {
        runId,
        observerKey: rootKey,
        families: [
          {
            family: "raiderio" as const,
            decision: "added_only" as const,
            reason: "raiderio_limited" as const,
            sweepReservationId: null,
            observed: [{ key: altKey, source: "claimed" as const }]
          }
        ]
      };
      const first = await connections().writeObservations(write);
      expect([...first.changedCharacterIds].sort()).toEqual(
        [observerId, altId].sort()
      );
      const second = await connections().writeObservations(write);
      expect(second.changedCharacterIds).toEqual([observerId]);
    });
  });

  async function groupOf(key: CharacterKey): Promise<string | undefined> {
    const result = await pool.query<{ group_id: string }>(
      `SELECT member.group_id FROM character_group_members member JOIN characters c ON c.id = member.character_id
         WHERE c.region = $1 AND c.realm_slug = $2 AND c.normalized_name = $3`,
      [key.region, key.realm, key.name]
    );
    return result.rows[0]?.group_id;
  }

  describe("group recompute, maintenance pass and rebuild", () => {
    it("merges into one group after a write, then splits when a link is retracted, the surviving part keeping the id", async () => {
      const first = await publishedRun();
      const written = await connections().writeObservations({
        runId: first,
        observerKey: rootKey,
        families: [
          {
            family: "raiderio",
            decision: "replaced",
            reason: "raiderio_complete",
            sweepReservationId: null,
            observed: [
              { key: altKey, source: "claimed" },
              { key: thirdKey, source: "claimed" }
            ]
          }
        ]
      });
      await connections().recomputeGroupsOf(written.changedCharacterIds);
      const mergedGroupId = await groupOf(rootKey);
      expect(mergedGroupId).toBeDefined();
      expect(await groupOf(altKey)).toBe(mergedGroupId);
      expect(await groupOf(thirdKey)).toBe(mergedGroupId);

      // Backdate every group so the next recompute's stamp is provably new,
      // not just the row's own DEFAULT now() from creation.
      await pool.query(
        `UPDATE character_groups SET recomputed_at = now() - interval '1 hour'`
      );
      const before = (await pool.query<{ now: Date }>(`SELECT now() AS now`))
        .rows[0]!.now;

      const second = await publishedRun([
        observation(rootKey, "Ryii"),
        observation(altKey, "Alt", "claimed")
      ]);
      const retracted = await connections().writeObservations({
        runId: second,
        observerKey: rootKey,
        families: [
          {
            family: "raiderio",
            decision: "replaced",
            reason: "raiderio_complete",
            sweepReservationId: null,
            observed: [{ key: altKey, source: "claimed" }]
          }
        ]
      });
      await connections().recomputeGroupsOf(retracted.changedCharacterIds);

      // The bigger surviving part (root + alt) keeps the merged group's id;
      // a regression that hands it to the smaller part, or mints a new id
      // for everyone, must fail this.
      expect(await groupOf(rootKey)).toBe(mergedGroupId);
      expect(await groupOf(altKey)).toBe(mergedGroupId);
      const thirdGroupId = await groupOf(thirdKey);
      expect(thirdGroupId).toBeDefined();
      expect(thirdGroupId).not.toBe(mergedGroupId);

      const stamps = await pool.query<{ recomputed_at: Date }>(
        `SELECT recomputed_at FROM character_groups`
      );
      expect(stamps.rows.length).toBeGreaterThan(0);
      expect(stamps.rows.every((row) => row.recomputed_at >= before)).toBe(
        true
      );
    });

    it("closes recompute across a link whose own recompute never ran, not just across the seed's BFS", async () => {
      // Break caught: recomputeComponent stopped once it had pulled in an old
      // group's other members, without continuing the walk from them. A
      // character split off into its own group could still hold a committed
      // link to some other character (whose own recompute had not yet run,
      // or crashed) and that link was silently dropped, stamping a group
      // that was not actually a closed component.
      const first = await publishedRun();
      const written = await connections().writeObservations({
        runId: first,
        observerKey: rootKey,
        families: [
          {
            family: "raiderio",
            decision: "replaced",
            reason: "raiderio_complete",
            sweepReservationId: null,
            observed: [
              { key: altKey, source: "claimed" },
              { key: thirdKey, source: "claimed" }
            ]
          }
        ]
      });
      await connections().recomputeGroupsOf(written.changedCharacterIds);
      // root, alt and third (the eventual splitting-off character) are one
      // group.

      await publishedRunFor(eKey, [observation(eKey, "Eve")]);
      const eId = await characterId(eKey);
      await connections().recomputeGroupsOf([eId]);
      // eve is her own separate group.

      // A committed third-eve link whose own recompute never ran: inserted
      // directly, bypassing writeObservations/recomputeGroupsOf entirely.
      // No FK ties `discovery_run_id` to a real run, but `first` is a real,
      // already-published one anyway.
      const thirdId = await characterId(thirdKey);
      await pool.query(
        `INSERT INTO character_connections
           (character_low_id, character_high_id, kind, source, observed_from_character_id, discovery_run_id, observed_at)
         VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), 'observed', 'claimed', $1, $3, now())`,
        [thirdId, eId, first]
      );

      const second = await publishedRun([
        observation(rootKey, "Ryii"),
        observation(altKey, "Alt", "claimed")
      ]);
      await connections().writeObservations({
        runId: second,
        observerKey: rootKey,
        families: [
          {
            family: "raiderio",
            decision: "replaced",
            reason: "raiderio_complete",
            sweepReservationId: null,
            observed: [{ key: altKey, source: "claimed" }]
          }
        ]
      });
      // Seeded from root alone (not from third or a full changedCharacterIds
      // list, whose order across two ids is an unpinned UUID sort): root's
      // own BFS never touches the third-eve link directly, so this only
      // reaches eve at all if pulling in root's old group's other members
      // (third) also continues the walk from them.
      const rootId = await characterId(rootKey);
      await connections().recomputeGroupsOf([rootId]);

      expect(await groupOf(thirdKey)).toBe(await groupOf(eKey));
      expect(await groupOf(thirdKey)).not.toBe(await groupOf(rootKey));
      const thirdGroupId = await groupOf(thirdKey);
      const merged = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM character_group_members WHERE group_id = $1`,
        [thirdGroupId]
      );
      expect(Number(merged.rows[0]!.n)).toBe(2);
    });

    it("counts a manual connection as a link, excluded or not", async () => {
      await publishedRun([observation(rootKey, "Ryii")]);
      await publishedRunFor(altKey, [observation(altKey, "Alt")]);
      await repositories.manualConnections.add(rootKey, altKey);
      const ids = await pool.query<{ id: string }>(`SELECT id FROM characters`);
      await connections().recomputeGroupsOf(ids.rows.map((row) => row.id));
      expect(await groupOf(altKey)).toBe(await groupOf(rootKey));
    });

    it("recomputes every group in a pass, stops at its budget, and records a full cycle", async () => {
      await publishedRun();
      const first = await connections().recomputePass({ budgetMs: 30_000 });
      expect(first.cycleCompleted).toBe(true);
      const state = await pool.query(
        `SELECT cursor_group_id, last_cycle_completed_at IS NOT NULL AS completed, last_cycle_started_at <= last_cycle_completed_at AS ordered FROM character_groups_maintenance`
      );
      expect(state.rows[0]).toMatchObject({
        cursor_group_id: null,
        completed: true,
        ordered: true
      });

      // Prove the pass actually re-stamps every group it *walks*, not merely
      // ones it happens to create: backdate, then run a fresh full cycle.
      await pool.query(
        `UPDATE character_groups SET recomputed_at = now() - interval '1 hour'`
      );
      const before = (await pool.query<{ now: Date }>(`SELECT now() AS now`))
        .rows[0]!.now;
      const second = await connections().recomputePass({ budgetMs: 30_000 });
      expect(second.cycleCompleted).toBe(true);
      const stamps = await pool.query<{ recomputed_at: Date }>(
        `SELECT recomputed_at FROM character_groups`
      );
      expect(stamps.rows.length).toBeGreaterThan(0);
      expect(stamps.rows.every((row) => row.recomputed_at >= before)).toBe(
        true
      );

      const partial = await connections().recomputePass({ budgetMs: 0 });
      expect(partial.cycleCompleted).toBe(false);
    });

    it("refuses a maintenance cursor outside a cycle", async () => {
      await expect(
        pool.query(
          `UPDATE character_groups_maintenance
           SET cursor_group_id = gen_random_uuid(), cycle_started_at = NULL WHERE id = 1`
        )
      ).rejects.toThrow(/character_groups_maintenance_cursor_check/);
    });

    it("records only a cycle that recomputed every group, when two passes overlap", async () => {
      // Break caught: completing a cycle took three transactions (the step
      // that found no next group, an ungrouped drain, then the completion)
      // with no re-check between them. An overlapping pass (pg-boss retries
      // the job at 300 s while the first handler still runs) could complete
      // a cycle the other had already cleared, writing a NULL
      // `last_cycle_started_at`, or stamp complete a cycle its own drain had
      // just restarted, which recomputed nothing. The replay reads
      // `last_cycle_started_at` as "every group was recomputed after this".
      const addCharacters = async (prefix: string, count: number) => {
        for (let index = 0; index < count; index += 1) {
          const name = `${prefix}${String.fromCharCode(97 + index)}`;
          await pool.query(
            `INSERT INTO characters (region, realm_slug, normalized_name, display_name, class_name, level, raider_io_url)
             VALUES ('eu', 'draenor', $1, $1, 'Mage', 80, 'https://raider.io/x')`,
            [name]
          );
        }
      };
      await addCharacters("seeded", 12);
      await connections().recomputePass({ budgetMs: 30_000 });

      for (let round = 0; round < 10; round += 1) {
        await addCharacters(`round${String.fromCharCode(97 + round)}`, 3);
        const passes = await Promise.all([
          connections().recomputePass({ budgetMs: 30_000 }),
          connections().recomputePass({ budgetMs: 30_000 })
        ]);
        expect(passes.some((pass) => pass.cycleCompleted)).toBe(true);

        const state = await pool.query<{
          started: boolean;
          uncovered: string;
          ungrouped: string;
        }>(
          `SELECT m.last_cycle_started_at IS NOT NULL AS started,
                  (SELECT count(*) FROM character_groups g
                    WHERE m.last_cycle_started_at IS NULL
                       OR g.recomputed_at < m.last_cycle_started_at)::text AS uncovered,
                  (SELECT count(*) FROM characters c
                    WHERE NOT EXISTS (SELECT 1 FROM character_group_members gm WHERE gm.character_id = c.id))::text AS ungrouped
             FROM character_groups_maintenance m WHERE m.id = 1`
        );
        expect({ round, ...state.rows[0] }).toEqual({
          round,
          started: true,
          uncovered: "0",
          ungrouped: "0"
        });
      }
    });

    it("rebuilds from snapshots under the exclusive lock, excluding concurrent writes", async () => {
      // Break caught: a write interleaving with the rebuild's delete and
      // re-insert left observations the ledger could not explain.
      const runId = await publishedRun();
      const hold = await pool.connect();
      try {
        await hold.query("BEGIN");
        await hold.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('character-groups-rebuild', 0))"
        );
        await expect(
          connections().writeObservations({
            runId,
            observerKey: rootKey,
            families: [
              {
                family: "raiderio",
                decision: "added_only",
                reason: "raiderio_limited",
                sweepReservationId: null,
                observed: [{ key: altKey, source: "claimed" }]
              }
            ]
          })
        ).rejects.toThrow(/lock timeout/);
      } finally {
        await hold.query("ROLLBACK");
        hold.release();
      }
      const rebuilt = await connections().rebuild();
      // Exact counts for this fixture: root's snapshot has two `claimed`
      // members (alt, third) and no fingerprint sweep, so exactly two
      // observed links from exactly one observer.
      expect(rebuilt.observers).toBe(1);
      expect(rebuilt.links).toBe(2);
      expect(rebuilt.groups).toBeGreaterThan(0);
      const ledger = await pool.query(
        `SELECT DISTINCT reason, decision FROM character_connection_write_log`
      );
      expect(ledger.rows).toContainEqual({
        reason: "rebuild",
        decision: "replaced"
      });
    });

    it("takes the rebuild lock exclusively, blocking until a shared holder releases it", async () => {
      await publishedRun();
      const hold = await pool.connect();
      try {
        await hold.query("BEGIN");
        await hold.query(
          "SELECT pg_advisory_xact_lock_shared(hashtextextended('character-groups-rebuild', 0))"
        );
        const rebuildPromise = connections().rebuild();
        const TIMED_OUT = Symbol("timed_out");
        const raced = await Promise.race([
          rebuildPromise,
          new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 300))
        ]);
        expect(raced).toBe(TIMED_OUT);
        await hold.query("ROLLBACK");
        const rebuilt = await rebuildPromise;
        expect(rebuilt.groups).toBeGreaterThan(0);
      } finally {
        hold.release();
      }
    });

    it("preserves rejections and earlier ledger rows, excluding a rejected pair from its groups", async () => {
      const runId = await publishedRun();
      const rootId = await characterId(rootKey);
      const altId = await characterId(altKey);

      // A pre-existing rejection between root and alt: the rebuild's groups
      // statement must never treat this pair as linked, even though its
      // raw Raider.IO observation is re-derived fresh from the snapshot.
      await pool.query(
        `INSERT INTO character_connections
           (character_low_id, character_high_id, kind, rejection_id, rejected_from_character_id, observed_at)
         VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), 'rejected', gen_random_uuid(), $1, now())`,
        [rootId, altId]
      );

      // An earlier, unrelated ledger row the rebuild must not disturb.
      await pool.query(
        `INSERT INTO character_connection_write_log
           (run_id, sweep_reservation_id, observer_character_id, family, decision, reason, run_started_at)
         VALUES ($1, NULL, $2, 'raiderio', 'added_only', 'capped', now() - interval '2 hours')`,
        [runId, rootId]
      );

      const rebuilt = await connections().rebuild();
      expect(rebuilt.observers).toBe(1);
      expect(rebuilt.links).toBe(2);
      expect(rebuilt.groups).toBe(2);

      const rejection = await pool.query(
        `SELECT 1 FROM character_connections
         WHERE kind = 'rejected'
           AND character_low_id = LEAST($1::uuid, $2::uuid)
           AND character_high_id = GREATEST($1::uuid, $2::uuid)`,
        [rootId, altId]
      );
      expect(rejection.rowCount).toBe(1);

      const earlierLedger = await pool.query(
        `SELECT 1 FROM character_connection_write_log WHERE decision = 'added_only' AND reason = 'capped'`
      );
      expect(earlierLedger.rowCount).toBe(1);

      expect(await groupOf(altKey)).not.toBe(await groupOf(rootKey));
      expect(await groupOf(thirdKey)).toBe(await groupOf(rootKey));
    });
  });

  describe("failure paths", () => {
    it("rejects a missing run id and writes nothing", async () => {
      await expect(
        connections().writeObservations({
          runId: "00000000-0000-0000-0000-000000000000",
          observerKey: rootKey,
          families: [
            {
              family: "raiderio",
              decision: "added_only",
              reason: "raiderio_limited",
              sweepReservationId: null,
              observed: [{ key: altKey, source: "claimed" }]
            }
          ]
        })
      ).rejects.toThrow("character_connections_run_missing");
      expect(
        (await pool.query(`SELECT 1 FROM character_connections`)).rowCount
      ).toBe(0);
    });

    it("rejects a family/source mismatch and writes nothing", async () => {
      const runId = await publishedRun();
      await expect(
        connections().writeObservations({
          runId,
          observerKey: rootKey,
          families: [
            {
              family: "fingerprint",
              decision: "added_only",
              reason: "capped",
              sweepReservationId: null,
              observed: [{ key: altKey, source: "claimed" }]
            }
          ]
        })
      ).rejects.toThrow("character_connections_family_mismatch");
      expect(
        (await pool.query(`SELECT 1 FROM character_connections`)).rowCount
      ).toBe(0);
    });

    it("rejects an observer key that isn't the run's root", async () => {
      const runId = await publishedRun();
      await expect(
        connections().writeObservations({
          runId,
          observerKey: altKey,
          families: [
            {
              family: "raiderio",
              decision: "added_only",
              reason: "raiderio_limited",
              sweepReservationId: null,
              observed: [{ key: thirdKey, source: "claimed" }]
            }
          ]
        })
      ).rejects.toThrow("character_connections_run_root_mismatch");
      expect(
        (await pool.query(`SELECT 1 FROM character_connections`)).rowCount
      ).toBe(0);
    });
  });
});

/** Every existing table the writer must never write, ignoring clock columns. */
async function existingChecksum(pool: Pool): Promise<string> {
  const tables = [
    "snapshots",
    "snapshot_characters",
    "discovery_runs",
    "characters",
    "manual_dossier_connections",
    "dossier_character_exclusions",
    "fingerprint_sweep_states",
    "fingerprint_sweep_reservations",
    "fingerprint_sweep_admissions",
    "character_evidence_runs"
  ];
  const parts: string[] = [];
  for (const table of tables) {
    const result = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table}`
    );
    parts.push(`${table}=${result.rows[0]!.n}`);
  }
  return parts.join(",");
}
