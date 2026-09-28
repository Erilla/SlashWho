-- Character groups, phase 1 (#738). Discovery's observed links, a ledger of
-- what each publication decided, and the groups those links form. Nothing
-- reads these tables until phase 2; the worker writes them best effort after
-- each publication, and a replay compares them with today's dossiers.
--
-- They hold character ids, run and reservation ids, enum values and times
-- only. No existing table is altered, and no existing row is written.
CREATE TABLE "character_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_low_id" uuid NOT NULL,
	"character_high_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source" text,
	"observed_from_character_id" uuid,
	"discovery_run_id" uuid,
	"observed_at" timestamp with time zone NOT NULL,
	"rejection_id" uuid,
	"rejected_from_character_id" uuid,
	CONSTRAINT "character_connections_order_check" CHECK ("character_low_id" < "character_high_id"),
	CONSTRAINT "character_connections_kind_check" CHECK (("kind" = 'observed' AND "source" IN ('claimed', 'declared_main', 'profile_guess', 'fingerprint') AND "observed_from_character_id" IN ("character_low_id", "character_high_id") AND "discovery_run_id" IS NOT NULL AND "rejection_id" IS NULL AND "rejected_from_character_id" IS NULL) OR ("kind" = 'rejected' AND "source" IS NULL AND "observed_from_character_id" IS NULL AND "discovery_run_id" IS NULL AND "rejection_id" IS NOT NULL AND "rejected_from_character_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "character_connections" ADD CONSTRAINT "character_connections_low_fk" FOREIGN KEY ("character_low_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "character_connections" ADD CONSTRAINT "character_connections_high_fk" FOREIGN KEY ("character_high_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "character_connections_observation_idx" ON "character_connections" ("character_low_id", "character_high_id", "source", "observed_from_character_id") WHERE "kind" = 'observed';
--> statement-breakpoint
CREATE UNIQUE INDEX "character_connections_rejection_idx" ON "character_connections" ("character_low_id", "character_high_id", "rejection_id") WHERE "kind" = 'rejected';
--> statement-breakpoint
CREATE INDEX "character_connections_high_idx" ON "character_connections" ("character_high_id");
--> statement-breakpoint
CREATE INDEX "character_connections_observer_idx" ON "character_connections" ("observed_from_character_id", "source") WHERE "kind" = 'observed';
--> statement-breakpoint
-- A group is the characters counting links reach. `recomputed_at` is when its
-- membership was last recomputed, so the replay can tell a write still waiting
-- for its recompute from real drift.
CREATE TABLE "character_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recomputed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character_group_members" (
	"character_id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "character_group_members" ADD CONSTRAINT "character_group_members_character_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "character_group_members" ADD CONSTRAINT "character_group_members_group_fk" FOREIGN KEY ("group_id") REFERENCES "public"."character_groups"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "character_group_members_group_idx" ON "character_group_members" ("group_id");
--> statement-breakpoint
-- The newest write per observer and source family. It only moves forward, and
-- it is what stops a delayed, older write from undoing a newer one.
CREATE TABLE "character_connection_writes" (
	"observer_character_id" uuid NOT NULL,
	"family" text NOT NULL,
	"run_id" uuid NOT NULL,
	"run_started_at" timestamp with time zone NOT NULL,
	CONSTRAINT "character_connection_writes_pk" PRIMARY KEY("observer_character_id","family"),
	CONSTRAINT "character_connection_writes_family_check" CHECK ("family" IN ('raiderio', 'fingerprint'))
);
--> statement-breakpoint
ALTER TABLE "character_connection_writes" ADD CONSTRAINT "character_connection_writes_observer_fk" FOREIGN KEY ("observer_character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- One append-only row per publication per family, written in the same
-- transaction as its observations, so a row exists exactly when the write
-- committed. The replay reads the decision and reason from here, never
-- infers them.
CREATE TABLE "character_connection_write_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"sweep_reservation_id" uuid,
	"observer_character_id" uuid NOT NULL,
	"family" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"run_started_at" timestamp with time zone NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_connection_write_log_family_check" CHECK ("family" IN ('raiderio', 'fingerprint')),
	CONSTRAINT "character_connection_write_log_decision_check" CHECK ("decision" IN ('added_only', 'replaced', 'blocked')),
	CONSTRAINT "character_connection_write_log_reason_check" CHECK ("reason" IN ('raiderio_complete', 'raiderio_limited', 'privacy_hidden', 'capped', 'matched', 'unread', 'skipped_guild', 'live_sweep_completion', 'blocked_by_newer', 'backfill', 'rebuild'))
);
--> statement-breakpoint
CREATE INDEX "character_connection_write_log_observer_idx" ON "character_connection_write_log" ("observer_character_id", "family", "run_started_at", "written_at");
--> statement-breakpoint
CREATE INDEX "character_connection_write_log_run_idx" ON "character_connection_write_log" ("run_id");
--> statement-breakpoint
CREATE INDEX "character_connection_write_log_reservation_idx" ON "character_connection_write_log" ("sweep_reservation_id");
--> statement-breakpoint
-- One row: the maintenance recompute's cursor, and when a full cycle last
-- started and completed, which is how the replay knows drift is final.
CREATE TABLE "character_groups_maintenance" (
	"id" smallint PRIMARY KEY NOT NULL,
	"cursor_group_id" uuid,
	"cycle_started_at" timestamp with time zone,
	"last_cycle_started_at" timestamp with time zone,
	"last_cycle_completed_at" timestamp with time zone,
	CONSTRAINT "character_groups_maintenance_singleton_check" CHECK ("id" = 1)
);
--> statement-breakpoint
INSERT INTO "character_groups_maintenance" ("id") VALUES (1);
--> statement-breakpoint
-- Pin the snapshot each family's backfill reads, once, before any of it runs.
-- Drizzle applies pending migrations one statement at a time in a single
-- READ COMMITTED transaction: without this, a snapshot committed by the
-- still-running old worker between two of the statements below could change
-- which run a later statement (the ledger, or the DO check) attributes rows
-- to, even though an earlier statement already used a different one.
-- Snapshot membership rows are immutable per snapshot id, so every statement
-- after this point reads only these two pinned tables, never `snapshots`
-- again, and joins `snapshot_characters` by the pinned snapshot id.
CREATE TEMP TABLE "character_groups_backfill_latest" ON COMMIT DROP AS
SELECT DISTINCT ON (snapshot.root_character_id)
  snapshot.root_character_id AS root_character_id,
  snapshot.id AS snapshot_id,
  snapshot.discovery_run_id AS discovery_run_id,
  snapshot.refreshed_at AS refreshed_at,
  COALESCE(run.started_at, run.created_at) AS run_started_at
FROM snapshots snapshot
JOIN discovery_runs run ON run.id = snapshot.discovery_run_id AND run.status = 'complete'
ORDER BY snapshot.root_character_id, snapshot.refreshed_at DESC, snapshot.id DESC;
--> statement-breakpoint
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
ORDER BY snapshot.root_character_id, snapshot.refreshed_at DESC, snapshot.id DESC;
--> statement-breakpoint
-- Backfill Raider.IO links from each root's pinned latest snapshot. Raw
-- membership: suppression is applied when read, so it is not applied here.
INSERT INTO "character_connections" ("character_low_id", "character_high_id", "kind", "source", "observed_from_character_id", "discovery_run_id", "observed_at")
SELECT LEAST(latest.root_character_id, member.character_id), GREATEST(latest.root_character_id, member.character_id),
       'observed', member.discovery_source::text, latest.root_character_id, latest.discovery_run_id, latest.refreshed_at
FROM "character_groups_backfill_latest" latest
JOIN snapshot_characters member ON member.snapshot_id = latest.snapshot_id
WHERE member.character_id <> latest.root_character_id
  AND member.discovery_source::text IN ('claimed', 'declared_main', 'profile_guess');
--> statement-breakpoint
-- Backfill fingerprint links from each root's pinned swept snapshot.
INSERT INTO "character_connections" ("character_low_id", "character_high_id", "kind", "source", "observed_from_character_id", "discovery_run_id", "observed_at")
SELECT LEAST(swept.root_character_id, member.character_id), GREATEST(swept.root_character_id, member.character_id),
       'observed', 'fingerprint', swept.root_character_id, swept.discovery_run_id, swept.refreshed_at
FROM "character_groups_backfill_swept" swept
JOIN snapshot_characters member ON member.snapshot_id = swept.snapshot_id
WHERE member.character_id <> swept.root_character_id AND member.discovery_source::text = 'fingerprint';
--> statement-breakpoint
-- The marker and one `replaced` backfill ledger row per root and family, under
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
SELECT discovery_run_id, reservation_id, root_character_id, family, 'replaced', 'backfill', run_started_at FROM families;
--> statement-breakpoint
-- Groups: components over the backfilled links and every resolved manual
-- connection, excluded or not. Every character gets a group; a group's id is
-- its lowest member's id, which is stable and needs no mapping table.
WITH RECURSIVE edges AS (
  SELECT character_low_id AS a, character_high_id AS b FROM character_connections WHERE kind = 'observed'
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
  INSERT INTO "character_groups" ("id") SELECT DISTINCT group_id FROM labelled RETURNING id
)
INSERT INTO "character_group_members" ("character_id", "group_id")
SELECT labelled.character_id, labelled.group_id FROM labelled JOIN inserted ON inserted.id = labelled.group_id;
--> statement-breakpoint
-- Sanity check on the query above, not the real check (that is the replay):
-- every pinned-latest-snapshot member and every resolved manual target shares
-- its root's group. A failure rolls back this deploy's pending migrations;
-- no existing row is touched.
DO $$
DECLARE stray integer;
BEGIN
  WITH pairs AS (
    SELECT latest.root_character_id AS root, member.character_id AS other
    FROM "character_groups_backfill_latest" latest
    JOIN snapshot_characters member ON member.snapshot_id = latest.snapshot_id
    UNION ALL
    SELECT manual.root_character_id, target.id
    FROM manual_dossier_connections manual
    JOIN characters target ON target.region = manual.connected_region
      AND target.realm_slug = manual.connected_realm_slug
      AND target.normalized_name = manual.connected_normalized_name
  )
  SELECT count(*) INTO stray
  FROM pairs
  JOIN character_group_members root_group ON root_group.character_id = pairs.root
  JOIN character_group_members other_group ON other_group.character_id = pairs.other
  WHERE root_group.group_id <> other_group.group_id;
  IF stray > 0 THEN
    RAISE EXCEPTION 'character_groups_backfill_stray_members: %', stray;
  END IF;
END $$;
