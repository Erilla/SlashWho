/**
 * The rebuild's SQL, copied verbatim from the migration's backfill
 * (`drizzle/0068_character_groups.sql`), so the two never drift (#738).
 *
 * The rebuild runs while the live worker may still be publishing, so it must
 * see the same pinned snapshot the migration's backfill sees: `pinLatest`
 * and `pinSwept` pin each root's latest and swept snapshot into temp tables
 * once, before any other statement runs, and every statement after them
 * reads only those two pinned tables, never `snapshots` again.
 *
 * Two statements differ deliberately from the migration:
 * - `markerAndLedger` writes reason `'rebuild'` instead of `'backfill'`;
 * - `groups` adds `ON CONFLICT DO NOTHING` on the groups insert and
 *   `ON CONFLICT (character_id) DO UPDATE SET group_id = EXCLUDED.group_id`
 *   on the members insert (both currently inert: `rebuild()` always deletes
 *   `character_groups`/`character_group_members` first, so neither clause
 *   ever actually has anything to conflict with; on a real conflict,
 *   `ON CONFLICT DO NOTHING` on the groups insert would silently drop that
 *   group from `inserted`, and the final `JOIN inserted` would then drop its
 *   members too), plus a `NOT EXISTS` filter over its observed edges that
 *   excludes any pair with a `kind = 'rejected'` row, matching
 *   `COUNTING_LINKS_FROM`. The migration's own `groups` statement is left as
 *   it is: no rejection can exist before phase 3.
 */
export const REBUILD_SQL = {
  pinLatest: `
-- Pin the snapshot each family's backfill reads, once, before any of it runs.
-- Drizzle applies pending migrations one statement at a time in a single
-- READ COMMITTED transaction: without this, a snapshot committed by the
-- still-running old worker between two of the statements below could change
-- which run a later statement (the ledger, or the DO check) attributes rows
-- to, even though an earlier statement already used a different one.
-- Snapshot membership rows are immutable per snapshot id, so every statement
-- after this point reads only these two pinned tables, never \`snapshots\`
-- again, and joins \`snapshot_characters\` by the pinned snapshot id.
CREATE TEMP TABLE "character_groups_backfill_latest" ON COMMIT DROP AS
SELECT DISTINCT ON (snapshot.root_character_id)
  snapshot.root_character_id AS root_character_id,
  snapshot.id AS snapshot_id,
  snapshot.discovery_run_id AS discovery_run_id,
  snapshot.refreshed_at AS refreshed_at,
  COALESCE(run.started_at, run.created_at) AS run_started_at
FROM snapshots snapshot
JOIN discovery_runs run ON run.id = snapshot.discovery_run_id AND run.status = 'complete'
ORDER BY snapshot.root_character_id, snapshot.refreshed_at DESC, snapshot.id DESC;`,

  pinSwept: `
-- The same, restricted to runs whose sweep published, for the fingerprint
-- family. A later not_due refresh does not cut fingerprint members, as the
-- retraction rule says, so a root whose latest snapshot dropped them through
-- a not_due refresh still gets them from this older, swept snapshot.
CREATE TEMP TABLE "character_groups_backfill_swept" ON COMMIT DROP AS
SELECT DISTINCT ON (snapshot.root_character_id)
  snapshot.root_character_id AS root_character_id,
  snapshot.id AS snapshot_id,
  snapshot.discovery_run_id AS discovery_run_id,
  snapshot.refreshed_at AS refreshed_at,
  COALESCE(run.started_at, run.created_at) AS run_started_at,
  (SELECT reservation.id FROM fingerprint_sweep_admissions admission
     JOIN fingerprint_sweep_reservations reservation ON reservation.admission_id = admission.id
    WHERE admission.discovery_run_id = snapshot.discovery_run_id AND reservation.published
    ORDER BY reservation.finished_at DESC NULLS LAST LIMIT 1) AS reservation_id
FROM snapshots snapshot
JOIN discovery_runs run ON run.id = snapshot.discovery_run_id AND run.status = 'complete'
WHERE EXISTS (
  SELECT 1 FROM fingerprint_sweep_admissions admission
  JOIN fingerprint_sweep_reservations reservation ON reservation.admission_id = admission.id
  WHERE admission.discovery_run_id = snapshot.discovery_run_id AND reservation.published
)
ORDER BY snapshot.root_character_id, snapshot.refreshed_at DESC, snapshot.id DESC;`,

  raiderio: `
-- Backfill Raider.IO links from each root's pinned latest snapshot. Raw
-- membership: suppression is applied when read, so it is not applied here.
INSERT INTO "character_connections" ("character_low_id", "character_high_id", "kind", "source", "observed_from_character_id", "discovery_run_id", "observed_at")
SELECT LEAST(latest.root_character_id, member.character_id), GREATEST(latest.root_character_id, member.character_id),
       'observed', member.discovery_source::text, latest.root_character_id, latest.discovery_run_id, latest.refreshed_at
FROM "character_groups_backfill_latest" latest
JOIN snapshot_characters member ON member.snapshot_id = latest.snapshot_id
WHERE member.character_id <> latest.root_character_id
  AND member.discovery_source::text IN ('claimed', 'declared_main', 'profile_guess');`,

  fingerprint: `
-- Backfill fingerprint links from each root's pinned swept snapshot.
INSERT INTO "character_connections" ("character_low_id", "character_high_id", "kind", "source", "observed_from_character_id", "discovery_run_id", "observed_at")
SELECT LEAST(swept.root_character_id, member.character_id), GREATEST(swept.root_character_id, member.character_id),
       'observed', 'fingerprint', swept.root_character_id, swept.discovery_run_id, swept.refreshed_at
FROM "character_groups_backfill_swept" swept
JOIN snapshot_characters member ON member.snapshot_id = swept.snapshot_id
WHERE member.character_id <> swept.root_character_id AND member.discovery_source::text = 'fingerprint';`,

  markerAndLedger: `
-- The marker and one \`replaced\` backfill ledger row per root and family, under
-- the run whose pinned snapshot that family's rows came from.
WITH families AS (
  SELECT root_character_id, 'raiderio'::text AS family, discovery_run_id, run_started_at, NULL::uuid AS reservation_id
  FROM "character_groups_backfill_latest"
  UNION ALL
  SELECT root_character_id, 'fingerprint', discovery_run_id, run_started_at, reservation_id
  FROM "character_groups_backfill_swept"
), marker AS (
  INSERT INTO "character_connection_writes" ("observer_character_id", "family", "run_id", "run_started_at")
  SELECT root_character_id, family, discovery_run_id, run_started_at FROM families
)
INSERT INTO "character_connection_write_log" ("run_id", "sweep_reservation_id", "observer_character_id", "family", "decision", "reason", "run_started_at")
SELECT discovery_run_id, reservation_id, root_character_id, family, 'replaced', 'rebuild', run_started_at FROM families;`,

  groups: `
-- Groups: components over the backfilled links and every resolved manual
-- connection, excluded or not. Every character gets a group; a group's id is
-- its lowest member's id, which is stable and needs no mapping table. Unlike
-- the migration's own groups statement, a pair with a \`kind = 'rejected'\`
-- row is excluded here, matching \`COUNTING_LINKS_FROM\`: the rebuild can run
-- after phase 3 exists, so it must honour rejections the migration's
-- one-time backfill never had to.
WITH RECURSIVE edges AS (
  SELECT connection.character_low_id AS a, connection.character_high_id AS b
  FROM character_connections connection
  WHERE connection.kind = 'observed'
    AND NOT EXISTS (
      SELECT 1 FROM character_connections rejection
      WHERE rejection.kind = 'rejected'
        AND rejection.character_low_id = connection.character_low_id
        AND rejection.character_high_id = connection.character_high_id
    )
  UNION
  SELECT manual.root_character_id, target.id
  FROM manual_dossier_connections manual
  JOIN characters target ON target.region = manual.connected_region
    AND target.realm_slug = manual.connected_realm_slug
    AND target.normalized_name = manual.connected_normalized_name
  WHERE target.id <> manual.root_character_id
), undirected AS (
  SELECT a, b FROM edges UNION SELECT b, a FROM edges
), reach(start, node) AS (
  SELECT id, id FROM characters
  UNION
  SELECT reach.start, undirected.b FROM reach JOIN undirected ON undirected.a = reach.node
), labelled AS (
  SELECT start AS character_id, min(node::text)::uuid AS group_id FROM reach GROUP BY start
), inserted AS (
  INSERT INTO "character_groups" ("id") SELECT DISTINCT group_id FROM labelled
  ON CONFLICT DO NOTHING RETURNING id
)
INSERT INTO "character_group_members" ("character_id", "group_id")
SELECT labelled.character_id, labelled.group_id FROM labelled JOIN inserted ON inserted.id = labelled.group_id
ON CONFLICT (character_id) DO UPDATE SET group_id = EXCLUDED.group_id;`
} as const;
