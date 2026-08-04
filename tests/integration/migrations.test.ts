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
      "characters",
      "discovery_runs",
      "negative_character_cache",
      "rate_limit_events",
      "snapshot_characters",
      "snapshots",
      "suppressed_characters"
    ]);
  });

  it("can run repeatedly without applying the initial migration twice", async () => {
    await runMigrations(pool);
    await runMigrations(pool);

    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    expect(result.rows[0]?.count).toBe("1");
  });

  it("serializes concurrent migration attempts with an advisory lock", async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await pool.query("DROP SCHEMA drizzle CASCADE");

    await Promise.all([runMigrations(pool), runMigrations(pool)]);

    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    expect(result.rows[0]?.count).toBe("1");
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
});
