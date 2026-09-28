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
      expect(rows.rows).toEqual([{ source: "claimed", discovery_run_id: runId }]);
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
