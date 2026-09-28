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
