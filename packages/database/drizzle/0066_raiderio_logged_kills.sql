-- Raider.IO-logged first kills (#732).
--
-- A logged encounter is stored once and shared by every character and run
-- that names it. It is written outside the snapshot transaction; a reader
-- reaches one only through a published run's first kills, which are written
-- in the same transaction as the run's other evidence. The uploaders
-- (`log.sources`) and the raw response are never stored.
--
-- A row is one of two answers. A read carries the kill: a visible roster is
-- kept as first read, and a private one may be replaced by a later read. An
-- unavailable row is a permanent refusal (a deleted log, a 403, or a log of
-- another kill) with only its code, so later runs do not ask again until it
-- is due a re-read. `read_at` dates either answer.
CREATE TABLE "raiderio_logged_encounters" (
	"logged_encounter_id" bigint PRIMARY KEY NOT NULL,
	"unavailable_code" text,
	"raid_slug" text,
	"boss_slug" text,
	"pulled_at" timestamp with time zone,
	"defeated_at" timestamp with time zone,
	"duration_ms" integer,
	"guild_name" text,
	"guild_realm" text,
	"guild_region" text,
	"item_level_average" double precision,
	"item_level_min" double precision,
	"item_level_max" double precision,
	"death_count" integer,
	"vantus_count" integer,
	"roster_state" text,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "raiderio_logged_encounters_answer_check" CHECK (("unavailable_code" IS NULL AND "raid_slug" IS NOT NULL AND "boss_slug" IS NOT NULL AND "pulled_at" IS NOT NULL AND "defeated_at" IS NOT NULL AND "duration_ms" IS NOT NULL AND "item_level_average" IS NOT NULL AND "item_level_min" IS NOT NULL AND "item_level_max" IS NOT NULL AND "death_count" IS NOT NULL AND "vantus_count" IS NOT NULL AND "roster_state" IS NOT NULL) OR ("unavailable_code" IN ('not_found', 'private', 'schema_drift') AND "raid_slug" IS NULL AND "boss_slug" IS NULL AND "pulled_at" IS NULL AND "defeated_at" IS NULL AND "duration_ms" IS NULL AND "guild_name" IS NULL AND "item_level_average" IS NULL AND "item_level_min" IS NULL AND "item_level_max" IS NULL AND "death_count" IS NULL AND "vantus_count" IS NULL AND "roster_state" IS NULL)),
	CONSTRAINT "raiderio_logged_encounters_roster_state_check" CHECK ("roster_state" IS NULL OR "roster_state" IN ('available', 'private')),
	CONSTRAINT "raiderio_logged_encounters_guild_identity_check" CHECK (("guild_name" IS NULL AND "guild_realm" IS NULL AND "guild_region" IS NULL) OR ("guild_name" IS NOT NULL AND "guild_realm" IS NOT NULL AND "guild_region" IS NOT NULL)),
	CONSTRAINT "raiderio_logged_encounters_counts_check" CHECK ("duration_ms" >= 0 AND "death_count" >= 0 AND "vantus_count" >= 0)
);
--> statement-breakpoint
-- One row per raider. `realm` is the Blizzard realm slug and
-- `normalized_name` the lower-cased name, so a member is keyed exactly as a
-- `suppressed_characters` row is, and a removed raider is left off every
-- dossier's roster when it is read. The rows are kept on removal.
CREATE TABLE "raiderio_logged_encounter_members" (
	"logged_encounter_id" bigint NOT NULL,
	"raiderio_character_id" bigint NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"realm" text NOT NULL,
	"region" text NOT NULL,
	"class_name" text NOT NULL,
	"spec_name" text NOT NULL,
	"role" text NOT NULL,
	"item_level" double precision,
	CONSTRAINT "raiderio_logged_encounter_members_pk" PRIMARY KEY("logged_encounter_id","raiderio_character_id"),
	CONSTRAINT "raiderio_logged_encounter_members_role_check" CHECK ("role" IN ('tank', 'healer', 'dps'))
);
--> statement-breakpoint
ALTER TABLE "raiderio_logged_encounter_members" ADD CONSTRAINT "raiderio_logged_encounter_members_encounter_fk" FOREIGN KEY ("logged_encounter_id") REFERENCES "public"."raiderio_logged_encounters"("logged_encounter_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "character_raiderio_first_kills" (
	"evidence_run_id" uuid NOT NULL,
	"raid_slug" text NOT NULL,
	"boss_slug" text NOT NULL,
	"killed_at" timestamp with time zone NOT NULL,
	"guild_name" text,
	"guild_realm" text,
	"guild_region" text,
	"logged_encounter_id" bigint,
	"encounter_state" text NOT NULL,
	"encounter_limitation_code" text,
	"historic_world_rank" integer,
	"historic_rank_checked_at" timestamp with time zone,
	CONSTRAINT "character_raiderio_first_kills_pk" PRIMARY KEY("evidence_run_id","raid_slug","boss_slug"),
	CONSTRAINT "character_raiderio_first_kills_encounter_state_check" CHECK (("encounter_state" = 'read' AND "logged_encounter_id" IS NOT NULL AND "encounter_limitation_code" IS NULL) OR ("encounter_state" = 'unavailable' AND (("logged_encounter_id" IS NULL AND "encounter_limitation_code" IS NULL) OR ("logged_encounter_id" IS NOT NULL AND "encounter_limitation_code" IS NOT NULL)))),
	CONSTRAINT "character_raiderio_first_kills_guild_identity_check" CHECK (("guild_name" IS NULL AND "guild_realm" IS NULL AND "guild_region" IS NULL) OR ("guild_name" IS NOT NULL AND "guild_realm" IS NOT NULL AND "guild_region" IS NOT NULL)),
	CONSTRAINT "character_raiderio_first_kills_historic_world_rank_check" CHECK ("historic_world_rank" IS NULL OR "historic_world_rank" > 0)
);
--> statement-breakpoint
ALTER TABLE "character_raiderio_first_kills" ADD CONSTRAINT "character_raiderio_first_kills_evidence_run_id_character_evidence_runs_id_fk" FOREIGN KEY ("evidence_run_id") REFERENCES "public"."character_evidence_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- A fourth way for a run to be partial: its Raider.IO logged-encounter reads
-- fell short. The completion check encodes "a partial run must name a
-- shortfall" and is widened again, as 0022 and 0031 widened it.
ALTER TABLE "character_evidence_runs" ADD COLUMN "raiderio_limitation_code" text;
--> statement-breakpoint
ALTER TABLE "character_evidence_runs"
  DROP CONSTRAINT "character_evidence_runs_completion_limitations_check";
--> statement-breakpoint
ALTER TABLE "character_evidence_runs"
  ADD CONSTRAINT "character_evidence_runs_completion_limitations_check" CHECK (("character_evidence_runs"."status" = 'complete' AND "character_evidence_runs"."limitation_code" IS NULL) OR ("character_evidence_runs"."status" = 'partial' AND ("character_evidence_runs"."limitation_code" IS NOT NULL OR "character_evidence_runs"."parse_limitation_code" IS NOT NULL OR "character_evidence_runs"."kill_scan_skipped" OR "character_evidence_runs"."raiderio_limitation_code" IS NOT NULL)) OR "character_evidence_runs"."status" NOT IN ('complete', 'partial'));
--> statement-breakpoint
-- What the new phase costs, beside the other Raider.IO requests (#298).
ALTER TABLE "character_evidence_run_costs"
  ADD COLUMN "raiderio_logged_encounter_requests" integer DEFAULT 0 NOT NULL;
