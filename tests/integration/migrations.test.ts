import { readFileSync } from "node:fs";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../packages/database/src";
import { startPostgres } from "./postgres";

describe("database migrations", () => {
  let pool: Pool;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    ({ pool, stop } = await startPostgres());
  });

  afterAll(async () => {
    await stop();
  });

  it("creates every application table in an empty PostgreSQL database", async () => {
    await runMigrations(pool);

    const result = await pool.query<{ name: string }>(`
      SELECT tablename AS name
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);

    expect(result.rows.map(({ name }) => name)).toEqual([
      "character_evidence_runs",
      "character_mythic_kills",
      "character_mythic_wipes",
      "characters",
      "discovery_runs",
      "fingerprint_sweep_admissions",
      "fingerprint_sweep_request_events",
      "fingerprint_sweep_reservations",
      "fingerprint_sweep_states",
      "manual_dossier_connections",
      "negative_character_cache",
      "rate_limit_events",
      "snapshot_characters",
      "snapshots",
      "suppressed_characters"
    ]);
  });

  it("can run repeatedly without applying migrations twice", async () => {
    await runMigrations(pool);
    const before = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    await runMigrations(pool);
    const after = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );

    expect(Number(before.rows[0]?.count)).toBeGreaterThan(0);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("chains wipe-fight and parse snapshots after the historical wipe schema", () => {
    const directory = new URL(
      "../../packages/database/drizzle/meta/",
      import.meta.url
    );
    const readSnapshot = (name: string) =>
      JSON.parse(readFileSync(new URL(name, directory), "utf8")) as {
        id: string;
        prevId: string;
        tables: Record<
          string,
          { indexes: Record<string, unknown>; columns: Record<string, unknown> }
        >;
      };
    const historicalWipes = readSnapshot("0007_snapshot.json");
    const wipeFights = readSnapshot("0008_snapshot.json");
    const parses = readSnapshot("0009_snapshot.json");
    const journal = JSON.parse(
      readFileSync(new URL("_journal.json", directory), "utf8")
    ) as { entries: Array<{ idx: number; tag: string }> };

    expect(wipeFights.prevId).toBe(historicalWipes.id);
    expect(parses.prevId).toBe(wipeFights.id);
    expect(
      journal.entries.slice(-3).map(({ idx, tag }) => ({ idx, tag }))
    ).toEqual([
      { idx: 12, tag: "0013_character_kill_specs" },
      { idx: 13, tag: "0014_manual_connections_by_key" },
      { idx: 14, tag: "0015_manual_connection_exclusions" }
    ]);
    expect(
      wipeFights.tables["public.character_mythic_wipes"]?.indexes
    ).toHaveProperty("character_mythic_wipes_run_fight_idx");
    expect(
      parses.tables["public.character_mythic_wipes"]?.indexes
    ).toHaveProperty("character_mythic_wipes_run_fight_idx");
    expect(
      parses.tables["public.character_mythic_kills"]?.columns
    ).toHaveProperty("damage_parse_state");
  });

  it("serializes concurrent migration attempts with an advisory lock", async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await pool.query("DROP SCHEMA drizzle CASCADE");

    await Promise.all([runMigrations(pool), runMigrations(pool)]);

    const result = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'rate_limit_events'
         AND column_name = 'discovery_run_id'`
    );
    expect(result.rows).toEqual([{ column_name: "discovery_run_id" }]);
  });

  it("enforces canonical character uniqueness in PostgreSQL", async () => {
    const values = [
      "eu",
      "silvermoon",
      "ryii",
      "Ryii",
      "Mage",
      80,
      "https://raider.io/characters/eu/silvermoon/ryii"
    ];
    await pool.query(
      `INSERT INTO characters
        (region, realm_slug, normalized_name, display_name, class_name, level, raider_io_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      values
    );

    await expect(
      pool.query(
        `INSERT INTO characters
          (region, realm_slug, normalized_name, display_name, class_name, level, raider_io_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        values
      )
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("keeps both legacy and newly reserved evidence at version one", async () => {
    // Break caught: applying the wipe-aware migration could falsely certify
    // pre-existing scans that never collected wipe evidence.
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await pool.query(
      "CREATE TABLE character_evidence_runs (id integer PRIMARY KEY)"
    );
    await pool.query("INSERT INTO character_evidence_runs (id) VALUES (1)");
    const migration = readFileSync(
      new URL(
        "../../packages/database/drizzle/0007_wipe_capable_evidence.sql",
        import.meta.url
      ),
      "utf8"
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await pool.query(statement);
    }
    await pool.query("INSERT INTO character_evidence_runs (id) VALUES (2)");

    const versions = await pool.query<{ id: number; evidence_version: number }>(
      "SELECT id, evidence_version FROM character_evidence_runs ORDER BY id"
    );
    expect(versions.rows).toEqual([
      { id: 1, evidence_version: 1 },
      { id: 2, evidence_version: 1 }
    ]);
  });
});
