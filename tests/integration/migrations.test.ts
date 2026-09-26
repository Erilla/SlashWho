import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      "account_api_credentials",
      "account_auth_events",
      "account_mail_outbox",
      "account_mail_tokens",
      "account_request_attempts",
      "account_sessions",
      "accounts",
      "applicant_source_counts",
      "applicant_source_intents",
      "applicant_source_state",
      "applicant_suppression_history",
      "character_alias_recollections",
      "character_attendance_searches",
      "character_evidence_collections",
      "character_evidence_cutting_edges",
      "character_evidence_run_costs",
      "character_evidence_run_phases",
      "character_evidence_runs",
      "character_historic_aliases",
      "character_mythic_kills",
      "character_mythic_wipes",
      "character_terminal_tiers",
      "character_tier_best_parses",
      "characters",
      "discovery_runs",
      "dossier_character_exclusions",
      "dossier_searches",
      "fingerprint_sweep_admissions",
      "fingerprint_sweep_request_events",
      "fingerprint_sweep_reservations",
      "fingerprint_sweep_states",
      "manual_dossier_connections",
      "negative_character_cache",
      "operator_auth_events",
      "operator_login_attempts",
      "operator_sessions",
      "operators",
      "rate_limit_events",
      "snapshot_characters",
      "snapshots",
      "suppressed_characters",
      "warcraft_logs_character_ids"
    ]);

    const cursor = await pool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'character_evidence_runs'
        AND column_name = 'kill_scan_resume_page'
    `);
    expect(cursor.rows).toEqual([{ column_name: "kill_scan_resume_page" }]);

    const vestigialKillColumns = await pool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'character_mythic_kills'
        AND column_name IN ('is_final_boss', 'historic_world_rank', 'historic_rank_checked_at')
    `);
    expect(vestigialKillColumns.rows).toEqual([
      { column_name: "historic_rank_checked_at" },
      { column_name: "historic_world_rank" }
    ]);

    const wipeFightIndex = await pool.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'character_mythic_wipes'
        AND indexname = 'character_mythic_wipes_run_fight_idx'
    `);
    expect(wipeFightIndex.rows).toEqual([
      { indexname: "character_mythic_wipes_run_fight_idx" }
    ]);

    const damageParseState = await pool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'character_mythic_kills'
        AND column_name = 'damage_parse_state'
    `);
    expect(damageParseState.rows).toEqual([
      { column_name: "damage_parse_state" }
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

  it("chains wipe-fight, parse, and report-provenance migrations", () => {
    const journal = JSON.parse(
      readFileSync(
        new URL(
          "../../packages/database/drizzle/meta/_journal.json",
          import.meta.url
        ),
        "utf8"
      )
    ) as { entries: Array<{ idx: number; tag: string }> };

    expect(
      journal.entries.slice(-30).map(({ idx, tag }) => ({ idx, tag }))
    ).toEqual([
      { idx: 28, tag: "0029_parse_only_scan_state" },
      { idx: 29, tag: "0030_unstick_schema_drift_runs" },
      { idx: 30, tag: "0031_partial_scan_skipped" },
      { idx: 31, tag: "0032_report_provenance" },
      { idx: 32, tag: "0033_history_scan_resume_boundary" },
      { idx: 33, tag: "0034_remove_vestigial_kill_columns" },
      { idx: 34, tag: "0035_operator_auth" },
      { idx: 35, tag: "0036_kill_guild_region" },
      { idx: 36, tag: "0037_fingerprint_historical_guilds" },
      { idx: 37, tag: "0038_evidence_run_phases" },
      { idx: 38, tag: "0039_evidence_cutting_edges" },
      { idx: 39, tag: "0040_mythic_kill_world_rank" },
      { idx: 40, tag: "0041_mythic_kill_rank_checked" },
      { idx: 41, tag: "0042_evidence_run_recovery_costs" },
      { idx: 42, tag: "0043_character_attendance_searches" },
      { idx: 43, tag: "0044_warcraft_logs_character_ids" },
      { idx: 44, tag: "0045_tier_search_runs" },
      { idx: 45, tag: "0046_ranked_backfill_cursor" },
      { idx: 46, tag: "0047_character_historic_aliases" },
      { idx: 47, tag: "0048_applicant_watcher" },
      { idx: 48, tag: "0049_optional_accounts" },
      { idx: 49, tag: "0050_conventional_account_email" },
      { idx: 50, tag: "0051_omitted_invalid_fight_timestamp" },
      { idx: 51, tag: "0052_tier_search_publication_scope" },
      { idx: 52, tag: "0053_other_upstream_run_costs" },
      { idx: 53, tag: "0054_evidence_run_timings" },
      { idx: 54, tag: "0055_dossier_searches" },
      { idx: 55, tag: "0056_persistent_account_sessions" },
      { idx: 56, tag: "0057_evidence_run_light_refresh" },
      { idx: 57, tag: "0058_snapshot_character_lookup_index" }
    ]);
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

  it("creates indexed, revocable operator authentication persistence", async () => {
    // Break caught: a migration that omits any operator-auth store, makes the
    // login lookup non-unique, or drops the query paths authentication needs.
    const columns = async (tableName: string) => {
      const result = await pool.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY column_name`,
        [tableName]
      );
      return result.rows.map(({ column_name }) => column_name);
    };

    expect(await columns("operators")).toContain("canonical_login");
    expect(await columns("operator_sessions")).toEqual(
      expect.arrayContaining([
        "operator_id",
        "secret_digest",
        "credential_version",
        "idle_expires_at",
        "absolute_expires_at",
        "revoked_at"
      ])
    );
    expect(await columns("operator_login_attempts")).toEqual(
      expect.arrayContaining(["subject_hash", "expires_at"])
    );
    expect(await columns("operator_auth_events")).toEqual(
      expect.arrayContaining([
        "operator_id",
        "action",
        "outcome",
        "occurred_at"
      ])
    );

    const insertOperator = (canonicalLogin: string) =>
      pool.query(
        `INSERT INTO operators
          (canonical_login, display_login, password_hash, password_salt, scrypt_version, scrypt_cost)
         VALUES ($1, 'Operator', 'hash', 'salt', 1, 16384)`,
        [canonicalLogin]
      );

    await expect(insertOperator("operator")).resolves.toBeDefined();
    await expect(insertOperator("operator")).rejects.toMatchObject({
      code: "23505"
    });
    await expect(insertOperator("Operator")).rejects.toMatchObject({
      code: "23514"
    });
    await expect(insertOperator("operator-é")).rejects.toMatchObject({
      code: "23514"
    });
    await expect(insertOperator("a".repeat(65))).rejects.toMatchObject({
      code: "23514"
    });

    await expect(
      pool.query(
        `INSERT INTO operator_auth_events (action, outcome)
         VALUES ('sign_in', 'success')`
      )
    ).resolves.toBeDefined();
    await expect(
      pool.query(
        `INSERT INTO operator_auth_events (action, outcome)
         VALUES ('password=unsafe', 'success')`
      )
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO operator_auth_events (action, outcome)
         VALUES ('sign_in', 'cookie=v1.secret')`
      )
    ).rejects.toMatchObject({ code: "23514" });

    const indexes = await pool.query<{ tablename: string; indexdef: string }>(
      `SELECT tablename, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN ('operator_sessions', 'operator_login_attempts', 'operator_auth_events')`
    );
    const indexDef = (tableName: string) =>
      indexes.rows
        .filter(({ tablename }) => tablename === tableName)
        .map(({ indexdef }) => indexdef)
        .join("\n");

    expect(indexDef("operator_sessions")).toMatch(
      /operator_id[\s\S]*revoked_at[\s\S]*IS NULL/
    );
    expect(indexDef("operator_login_attempts")).toMatch(
      /subject_hash[\s\S]*expires_at/
    );
    expect(indexDef("operator_auth_events")).toMatch(
      /operator_id[\s\S]*occurred_at/
    );
  });

  it("adds the fingerprint sweep cursor columns", async () => {
    const columns = await pool.query<{
      column_name: string;
      is_nullable: string;
    }>(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'fingerprint_sweep_states'
         AND column_name IN
           ('resume_after', 'resume_limitation_code',
            'resume_historical_guilds', 'resume_snapshot_id')
       ORDER BY column_name`
    );
    expect(columns.rows).toEqual([
      { column_name: "resume_after", is_nullable: "YES" },
      { column_name: "resume_historical_guilds", is_nullable: "YES" },
      { column_name: "resume_limitation_code", is_nullable: "YES" },
      { column_name: "resume_snapshot_id", is_nullable: "YES" }
    ]);
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

  it("resets legacy operators while retaining auth events and public data", async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await pool.query("DROP SCHEMA drizzle CASCADE");

    const migrationSource = new URL(
      "../../packages/database/drizzle/",
      import.meta.url
    );
    const folder = mkdtempSync(join(tmpdir(), "slashwho-migrations-"));
    try {
      mkdirSync(join(folder, "meta"));
      for (const file of readdirSync(migrationSource).filter(
        (name) => name.endsWith(".sql") && name.slice(0, 4) <= "0046"
      )) {
        copyFileSync(new URL(file, migrationSource), join(folder, file));
      }
      const journal = JSON.parse(
        readFileSync(new URL("meta/_journal.json", migrationSource), "utf8")
      ) as { entries: Array<{ idx: number }> };
      journal.entries = journal.entries.filter(({ idx }) => idx <= 45);
      writeFileSync(
        join(folder, "meta", "_journal.json"),
        JSON.stringify(journal)
      );
      process.env.SLASHWHO_MIGRATIONS_FOLDER = folder;
      try {
        await runMigrations(pool);
      } finally {
        delete process.env.SLASHWHO_MIGRATIONS_FOLDER;
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }

    const operator = await pool.query<{ id: string }>(
      `INSERT INTO operators
        (canonical_login, display_login, password_hash, password_salt, scrypt_version, scrypt_cost)
       VALUES ('legacy', 'Legacy', 'hash', 'salt', 1, 16384) RETURNING id`
    );
    const operatorId = operator.rows[0]!.id;
    await pool.query(
      `INSERT INTO operator_sessions
        (secret_digest, operator_id, credential_version, issued_at, last_used_at,
         idle_expires_at, absolute_expires_at)
       VALUES ('digest', $1, 1, now(), now(), now() + interval '1 day', now() + interval '7 days')`,
      [operatorId]
    );
    const event = await pool.query<{ occurred_at: Date }>(
      `INSERT INTO operator_auth_events (operator_id, action, outcome)
       VALUES ($1, 'sign_in', 'success') RETURNING occurred_at`,
      [operatorId]
    );
    await pool.query(
      `INSERT INTO characters
        (region, realm_slug, normalized_name, display_name, class_name, level, raider_io_url)
       VALUES ('eu', 'silvermoon', 'migration-fixture', 'Migration Fixture', 'Mage', 80, 'https://example.com')`
    );

    await runMigrations(pool);

    const tables = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    );
    expect(tables.rows.map((row) => row.tablename)).toContain("accounts");
    expect(tables.rows.map((row) => row.tablename)).toContain(
      "account_mail_outbox"
    );
    expect(tables.rows.map((row) => row.tablename)).toContain(
      "account_api_credentials"
    );
    expect((await pool.query("SELECT id FROM operators")).rows).toHaveLength(0);
    expect(
      (await pool.query("SELECT id FROM operator_sessions")).rows
    ).toHaveLength(0);
    expect(
      (
        await pool.query(
          "SELECT operator_id, action, occurred_at FROM operator_auth_events"
        )
      ).rows
    ).toContainEqual({
      operator_id: null,
      action: "sign_in",
      occurred_at: event.rows[0]!.occurred_at
    });
    expect(
      (
        await pool.query(
          "SELECT id FROM characters WHERE normalized_name = 'migration-fixture'"
        )
      ).rows
    ).toHaveLength(1);
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'character_evidence_runs'
         AND column_name IN ('account_credential_owner_id', 'account_credential_version')`
    );
    expect(columns.rows.map(({ column_name }) => column_name)).toEqual(
      expect.arrayContaining([
        "account_credential_owner_id",
        "account_credential_version"
      ])
    );
  });

  it("lifts the absolute lifetime from live account sessions only", async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await pool.query("DROP SCHEMA drizzle CASCADE");

    const migrationSource = new URL(
      "../../packages/database/drizzle/",
      import.meta.url
    );
    const folder = mkdtempSync(join(tmpdir(), "slashwho-migrations-"));
    try {
      mkdirSync(join(folder, "meta"));
      for (const file of readdirSync(migrationSource).filter(
        (name) => name.endsWith(".sql") && name.slice(0, 4) <= "0055"
      )) {
        copyFileSync(new URL(file, migrationSource), join(folder, file));
      }
      const journal = JSON.parse(
        readFileSync(new URL("meta/_journal.json", migrationSource), "utf8")
      ) as { entries: Array<{ idx: number }> };
      journal.entries = journal.entries.filter(({ idx }) => idx <= 54);
      writeFileSync(
        join(folder, "meta", "_journal.json"),
        JSON.stringify(journal)
      );
      process.env.SLASHWHO_MIGRATIONS_FOLDER = folder;
      try {
        await runMigrations(pool);
      } finally {
        delete process.env.SLASHWHO_MIGRATIONS_FOLDER;
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }

    const account = await pool.query<{ id: string }>(
      `INSERT INTO accounts
        (canonical_email, email, password_hash, password_salt, scrypt_version, scrypt_cost, verified_at)
       VALUES ('lifetime@example.com', 'lifetime@example.com', 'hash', 'salt', 1, 16384, now())
       RETURNING id`
    );
    const revokedAt = new Date("2026-09-25T12:00:00Z");
    const absolute = new Date("2026-09-25T20:00:00Z");
    const insert = (revoked: Date | null) =>
      pool.query<{ id: string }>(
        `INSERT INTO account_sessions
          (secret_digest, account_id, credential_version, issued_at, last_used_at,
           idle_expires_at, absolute_expires_at, revoked_at)
         VALUES ('digest', $1, 1, now(), now(), now() + interval '30 minutes', $2, $3)
         RETURNING id`,
        [account.rows[0]!.id, absolute, revoked]
      );
    const live = (await insert(null)).rows[0]!.id;
    const revoked = (await insert(revokedAt)).rows[0]!.id;

    await runMigrations(pool);

    const sessions = await pool.query<{
      id: string;
      absolute_expires_at: Date | null;
    }>("SELECT id, absolute_expires_at FROM account_sessions");
    expect(sessions.rows).toEqual(
      expect.arrayContaining([
        { id: live, absolute_expires_at: null },
        { id: revoked, absolute_expires_at: absolute }
      ])
    );
  });

  it("indexes snapshot membership by character on an already-migrated database", async () => {
    // Break caught: the index lived only in an orphaned 0011 file the journal
    // never listed, so no database ever had it. Re-adding it under a past
    // timestamp would still skip every database that had applied 0057.
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await pool.query("DROP SCHEMA drizzle CASCADE");

    const migrationSource = new URL(
      "../../packages/database/drizzle/",
      import.meta.url
    );
    const folder = mkdtempSync(join(tmpdir(), "slashwho-migrations-"));
    try {
      mkdirSync(join(folder, "meta"));
      for (const file of readdirSync(migrationSource).filter(
        (name) => name.endsWith(".sql") && name.slice(0, 4) <= "0057"
      )) {
        copyFileSync(new URL(file, migrationSource), join(folder, file));
      }
      const journal = JSON.parse(
        readFileSync(new URL("meta/_journal.json", migrationSource), "utf8")
      ) as { entries: Array<{ tag: string }> };
      journal.entries = journal.entries.filter(
        ({ tag }) => tag.slice(0, 4) <= "0057"
      );
      writeFileSync(
        join(folder, "meta", "_journal.json"),
        JSON.stringify(journal)
      );
      process.env.SLASHWHO_MIGRATIONS_FOLDER = folder;
      try {
        await runMigrations(pool);
      } finally {
        delete process.env.SLASHWHO_MIGRATIONS_FOLDER;
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }

    const index = () =>
      pool.query<{ indexdef: string }>(
        `SELECT indexdef
         FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = 'snapshot_characters_character_idx'`
      );
    expect((await index()).rows).toEqual([]);

    await runMigrations(pool);

    expect((await index()).rows).toEqual([
      {
        indexdef: expect.stringContaining(
          "ON public.snapshot_characters USING btree (character_id)"
        )
      }
    ]);
  });
});
