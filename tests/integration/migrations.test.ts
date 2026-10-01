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
      "character_connection_write_log",
      "character_connection_writes",
      "character_connections",
      "character_evidence_collections",
      "character_evidence_cutting_edges",
      "character_evidence_run_costs",
      "character_evidence_run_phases",
      "character_evidence_runs",
      "character_group_members",
      "character_groups",
      "character_groups_maintenance",
      "character_historic_aliases",
      "character_mythic_kills",
      "character_mythic_wipes",
      "character_raiderio_first_kills",
      "character_raiderio_tier_reads",
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
      "raiderio_logged_encounter_members",
      "raiderio_logged_encounters",
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

    // Each evidence table's unique index leads with evidence_run_id, so a
    // separate index on that column alone only added write cost.
    const evidenceRunIndexes = await pool.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('character_mythic_kills', 'character_tier_best_parses', 'character_mythic_wipes')
        AND indexdef LIKE '%(evidence_run_id%'
      ORDER BY indexname
    `);
    expect(evidenceRunIndexes.rows).toEqual([
      { indexname: "character_mythic_kills_source_fight_idx" },
      { indexname: "character_mythic_wipes_run_fight_idx" },
      { indexname: "character_tier_best_parses_encounter_idx" }
    ]);

    // Existing runs read as having dropped no guild reads, never as NULL.
    const guildReadsDropped = await pool.query<{
      is_nullable: string;
      column_default: string | null;
    }>(`
      SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'discovery_runs' AND column_name = 'guild_reads_dropped'
    `);
    expect(guildReadsDropped.rows).toEqual([
      { is_nullable: "NO", column_default: "0" }
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
      journal.entries.slice(-40).map(({ idx, tag }) => ({ idx, tag }))
    ).toEqual([
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
      { idx: 57, tag: "0058_snapshot_character_lookup_index" },
      { idx: 58, tag: "0059_applicant_parser_version" },
      { idx: 59, tag: "0060_drop_redundant_evidence_run_indexes" },
      { idx: 60, tag: "0061_discovery_guild_reads_dropped" },
      { idx: 61, tag: "0062_evidence_run_origin" },
      { idx: 62, tag: "0063_evidence_run_root" },
      { idx: 63, tag: "0064_history_actor_requests" },
      { idx: 64, tag: "0065_guild_report_requests" },
      { idx: 65, tag: "0066_raiderio_logged_kills" },
      { idx: 66, tag: "0067_raiderio_tier_reads" },
      { idx: 67, tag: "0068_raiderio_vantus_null" },
      { idx: 68, tag: "0069_character_groups" },
      { idx: 69, tag: "0070_fingerprint_excluded_tournament_characters" },
      { idx: 70, tag: "0071_discovery_evidence_origin" },
      { idx: 71, tag: "0072_fingerprint_delivery" }
    ]);
  });

  it("backfills character groups from today's snapshots without touching them", async () => {
    // Break caught: a backfill that rewrote snapshots, or grouped a
    // snapshot member apart from its root, would fail P1 and P2 on deploy.
    const { pool, stop } = await startPostgres();
    try {
      await runMigrationsThrough(pool, "0068_raiderio_vantus_null");
      const root = await insertCharacter(pool, "eu", "draenor", "quellaria");
      const alt = await insertCharacter(pool, "eu", "draenor", "eundariel");
      const fp = await insertCharacter(pool, "eu", "draenor", "drecthyr");
      const run = await insertCompletedRun(pool, root);
      await insertSnapshot(pool, run, root, [
        [root, "input"],
        [alt, "declared_main"],
        [fp, "fingerprint"]
      ]);
      await insertPublishedReservation(pool, run);

      // A second root whose *newer* snapshot has no published sweep and
      // drops its fingerprint member (a not_due refresh); its *older*
      // snapshot did publish a sweep and still has that member. Raider.IO
      // backfill must pin the newer run (the plain "latest" snapshot);
      // fingerprint backfill must pin the older, swept run. If either
      // pinned-temp-table CTE were transposed with the other, or a later
      // statement re-queried `snapshots` instead of the pinned table, this
      // would attribute the wrong run to the wrong family.
      const swappedRoot = await insertCharacter(
        pool,
        "eu",
        "draenor",
        "shendral"
      );
      const swappedFingerprintAlt = await insertCharacter(
        pool,
        "eu",
        "draenor",
        "mirendor"
      );
      const unlinkedCharacter = await insertCharacter(
        pool,
        "eu",
        "draenor",
        "solitaire"
      );
      const olderSweptRun = await insertCompletedRun(pool, swappedRoot, {
        startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        completedAt: new Date(Date.now() - 2 * 60 * 60 * 1000)
      });
      await insertSnapshot(
        pool,
        olderSweptRun,
        swappedRoot,
        [
          [swappedRoot, "input"],
          [swappedFingerprintAlt, "fingerprint"]
        ],
        { refreshedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }
      );
      const olderReservationId = await insertPublishedReservation(
        pool,
        olderSweptRun
      );
      const newerUnsweptRun = await insertCompletedRun(pool, swappedRoot, {
        startedAt: new Date(Date.now() - 30 * 60 * 1000),
        completedAt: new Date(Date.now() - 10 * 60 * 1000)
      });
      await insertSnapshot(
        pool,
        newerUnsweptRun,
        swappedRoot,
        [[swappedRoot, "input"]],
        { refreshedAt: new Date(Date.now() - 10 * 60 * 1000) }
      );

      // A manual connection, excluded, and a discovered exclusion, so P2's
      // checksum covers rows the backfill reads.
      const manualTarget = await insertCharacter(
        pool,
        "eu",
        "draenor",
        "handpicked"
      );
      await pool.query(
        `INSERT INTO manual_dossier_connections
           (root_character_id, connected_region, connected_realm_slug, connected_normalized_name, excluded_at)
         SELECT $1, region, realm_slug, normalized_name, now() FROM characters WHERE id = $2`,
        [root, manualTarget]
      );
      await pool.query(
        `INSERT INTO dossier_character_exclusions
           (root_character_id, region, realm_slug, normalized_name)
         SELECT $1, region, realm_slug, normalized_name FROM characters WHERE id = $2`,
        [root, alt]
      );

      // P2: every table that existed before 0069, whole rows, clock columns
      // included, because the migration must not change any of them.
      const existing = await publicTables(pool);
      expect(existing).toEqual(
        expect.arrayContaining([
          "snapshots",
          "snapshot_characters",
          "discovery_runs",
          "characters",
          "manual_dossier_connections",
          "dossier_character_exclusions",
          "fingerprint_sweep_states",
          "fingerprint_sweep_reservations",
          "fingerprint_sweep_admissions",
          "fingerprint_sweep_request_events",
          "character_evidence_runs"
        ])
      );
      expect(existing).not.toContain("character_connections");
      const before = await checksum(pool, existing);

      await runMigrationsThrough(pool, "0071_discovery_evidence_origin");

      expect(await checksum(pool, existing)).toBe(before);
      await runMigrations(pool);
      const manualGroups = await pool.query<{ n: string }>(
        `SELECT count(DISTINCT group_id)::text AS n FROM character_group_members WHERE character_id = ANY($1)`,
        [[root, manualTarget]]
      );
      expect(manualGroups.rows[0]!.n).toBe("1");
      const groups = await pool.query<{ n: string }>(
        `SELECT count(DISTINCT group_id)::text AS n FROM character_group_members WHERE character_id = ANY($1)`,
        [[root, alt, fp]]
      );
      expect(groups.rows[0]!.n).toBe("1");
      const ledger = await pool.query(
        `SELECT family, decision, reason FROM character_connection_write_log WHERE observer_character_id = $1 ORDER BY family`,
        [root]
      );
      expect(ledger.rows).toEqual([
        { family: "fingerprint", decision: "replaced", reason: "backfill" },
        { family: "raiderio", decision: "replaced", reason: "backfill" }
      ]);

      const swappedFingerprintConnection = await pool.query<{
        discovery_run_id: string;
        observed_from_character_id: string;
      }>(
        `SELECT discovery_run_id, observed_from_character_id FROM character_connections
         WHERE kind = 'observed' AND source = 'fingerprint' AND observed_from_character_id = $1`,
        [swappedRoot]
      );
      expect(swappedFingerprintConnection.rows).toEqual([
        {
          discovery_run_id: olderSweptRun,
          observed_from_character_id: swappedRoot
        }
      ]);

      const swappedMarkers = await pool.query<{
        family: string;
        run_id: string;
      }>(
        `SELECT family, run_id FROM character_connection_writes WHERE observer_character_id = $1 ORDER BY family`,
        [swappedRoot]
      );
      expect(swappedMarkers.rows).toEqual([
        { family: "fingerprint", run_id: olderSweptRun },
        { family: "raiderio", run_id: newerUnsweptRun }
      ]);

      const swappedFingerprintLedger = await pool.query<{
        sweep_reservation_id: string;
      }>(
        `SELECT sweep_reservation_id FROM character_connection_write_log
         WHERE observer_character_id = $1 AND family = 'fingerprint'`,
        [swappedRoot]
      );
      expect(swappedFingerprintLedger.rows).toEqual([
        { sweep_reservation_id: olderReservationId }
      ]);

      const unlinkedGroup = await pool.query<{
        character_id: string;
        group_id: string;
      }>(
        `SELECT character_id, group_id FROM character_group_members WHERE character_id = $1`,
        [unlinkedCharacter]
      );
      expect(unlinkedGroup.rows).toEqual([
        { character_id: unlinkedCharacter, group_id: unlinkedCharacter }
      ]);
    } finally {
      await stop();
    }
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

    await runMigrationsThrough(pool, "0046_ranked_backfill_cursor");

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

    await runMigrationsThrough(pool, "0055_dossier_searches");

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

    await runMigrationsThrough(pool, "0057_evidence_run_light_refresh");

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

  it("forgets stored schema_drift refusals and admits a read with no Vantus data", async () => {
    // #747: every schema_drift refusal stored before 0068 was a kill Raider.IO
    // sent `log.vantus: null` for. Forgotten, each is read again next run
    // rather than 30 days later; other refusals stand.
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
        (name) => name.endsWith(".sql") && name.slice(0, 4) <= "0067"
      )) {
        copyFileSync(new URL(file, migrationSource), join(folder, file));
      }
      const journal = JSON.parse(
        readFileSync(new URL("meta/_journal.json", migrationSource), "utf8")
      ) as { entries: Array<{ tag: string }> };
      journal.entries = journal.entries.filter(
        ({ tag }) => tag.slice(0, 4) <= "0067"
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

    await pool.query(
      `INSERT INTO raiderio_logged_encounters (logged_encounter_id, unavailable_code, read_at)
       VALUES (1, 'schema_drift', now()), (2, 'not_found', now()), (3, 'private', now())`
    );

    await runMigrations(pool);

    const kept = await pool.query<{ logged_encounter_id: string }>(
      `SELECT logged_encounter_id FROM raiderio_logged_encounters
        ORDER BY logged_encounter_id`
    );
    expect(kept.rows.map((row) => Number(row.logged_encounter_id))).toEqual([
      2, 3
    ]);
    await expect(
      pool.query(
        `INSERT INTO raiderio_logged_encounters (
           logged_encounter_id, raid_slug, boss_slug, pulled_at, defeated_at,
           duration_ms, item_level_average, item_level_min, item_level_max,
           death_count, vantus_count, roster_state, read_at
         ) VALUES (4, 'tier-mn-1', 'midnight-falls', now(), now(), 1, 1, 1, 1,
                   0, NULL, 'available', now())`
      )
    ).resolves.toBeDefined();
  });
});

/**
 * Migrates an empty database up to and including the migration whose file
 * name and journal tag start with `tag`'s first four digits, by copying only
 * those files (and journal entries) into a throwaway migrations folder. Used
 * to seed fixtures against a known-older schema before running the rest.
 */
async function runMigrationsThrough(pool: Pool, tag: string): Promise<void> {
  const prefix = tag.slice(0, 4);
  const migrationSource = new URL(
    "../../packages/database/drizzle/",
    import.meta.url
  );
  const folder = mkdtempSync(join(tmpdir(), "slashwho-migrations-"));
  try {
    mkdirSync(join(folder, "meta"));
    for (const file of readdirSync(migrationSource).filter(
      (name) => name.endsWith(".sql") && name.slice(0, 4) <= prefix
    )) {
      copyFileSync(new URL(file, migrationSource), join(folder, file));
    }
    const journal = JSON.parse(
      readFileSync(new URL("meta/_journal.json", migrationSource), "utf8")
    ) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter(
      ({ tag: entryTag }) => entryTag.slice(0, 4) <= prefix
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
}

async function insertCharacter(
  pool: Pool,
  region: string,
  realm: string,
  name: string
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO characters (region, realm_slug, normalized_name, display_name, class_name, level, raider_io_url)
     VALUES ($1, $2, $3, $3, 'Mage', 80, 'https://raider.io/x') RETURNING id`,
    [region, realm, name]
  );
  return result.rows[0]!.id;
}

async function insertCompletedRun(
  pool: Pool,
  rootId: string,
  timing: { startedAt?: Date; completedAt?: Date } = {}
): Promise<string> {
  const startedAt = timing.startedAt ?? new Date(Date.now() - 60 * 60 * 1000);
  const completedAt = timing.completedAt ?? new Date();
  const result = await pool.query<{ id: string }>(
    `INSERT INTO discovery_runs (root_region, root_realm_slug, root_normalized_name, root_character_id, status, caller_class, started_at, completed_at)
     SELECT region, realm_slug, normalized_name, id, 'complete', 'anonymous', $2, $3 FROM characters WHERE id = $1 RETURNING id`,
    [rootId, startedAt, completedAt]
  );
  return result.rows[0]!.id;
}

async function insertSnapshot(
  pool: Pool,
  runId: string,
  rootId: string,
  members: [string, string][],
  timing: { refreshedAt?: Date } = {}
): Promise<void> {
  const refreshedAt = timing.refreshedAt ?? new Date();
  const snapshot = await pool.query<{ id: string }>(
    `INSERT INTO snapshots (root_character_id, discovery_run_id, state, limitation_code, refreshed_at, character_count)
     VALUES ($1, $2, 'complete', NULL, $4, $3) RETURNING id`,
    [rootId, runId, members.length, refreshedAt]
  );
  await pool.query(`UPDATE discovery_runs SET snapshot_id = $2 WHERE id = $1`, [
    runId,
    snapshot.rows[0]!.id
  ]);
  for (const [index, [characterId, source]] of members.entries()) {
    await pool.query(
      `INSERT INTO snapshot_characters (snapshot_id, character_id, display_order, discovery_source, display_name, class_name, level, raider_io_url)
       VALUES ($1, $2, $3, $4, 'x', 'Mage', 80, 'https://raider.io/x')`,
      [snapshot.rows[0]!.id, characterId, index, source]
    );
  }
}

async function insertPublishedReservation(
  pool: Pool,
  runId: string
): Promise<string> {
  const admission = await pool.query<{ id: string }>(
    `INSERT INTO fingerprint_sweep_admissions (discovery_run_id, region, realm_slug, normalized_name, request_cap, hourly_budget, cadence_cutoff, status)
     SELECT id, root_region, root_realm_slug, root_normalized_name, 300, 28800, now(), 'finished' FROM discovery_runs WHERE id = $1 RETURNING id`,
    [runId]
  );
  const reservation = await pool.query<{ id: string }>(
    `INSERT INTO fingerprint_sweep_reservations (admission_id, request_cap, admitted_at, expires_at, released_at, finished_at, published)
     VALUES ($1, 300, now() - interval '1 hour', now() + interval '1 hour', now(), now(), true) RETURNING id`,
    [admission.rows[0]!.id]
  );
  return reservation.rows[0]!.id;
}

async function checksum(pool: Pool, tables: string[]): Promise<string> {
  const parts: string[] = [];
  for (const table of tables) {
    const result = await pool.query<{ digest: string }>(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest FROM "${table}" t`
    );
    parts.push(`${table}=${result.rows[0]!.digest}`);
  }
  return parts.join(":");
}

/** Every base table in the public schema, by name. */
async function publicTables(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`
  );
  return result.rows.map((row) => row.table_name);
}
