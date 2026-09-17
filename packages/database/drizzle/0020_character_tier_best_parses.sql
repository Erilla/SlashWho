CREATE TABLE "character_tier_best_parses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_run_id" uuid NOT NULL,
	"raid_id" text NOT NULL,
	"raid_name" text NOT NULL,
	"boss_id" text NOT NULL,
	"boss_name" text NOT NULL,
	"rankings_url" text NOT NULL,
	"spec_name" text,
	"spec_icon_url" text,
	"damage_parse_state" character_mythic_kill_parse_state NOT NULL,
	"damage_percentile" double precision,
	"healing_parse_state" character_mythic_kill_parse_state NOT NULL,
	"healing_percentile" double precision,
	"boss_damage_parse_state" character_mythic_kill_parse_state NOT NULL,
	"boss_damage_percentile" double precision,
	CONSTRAINT "character_tier_best_parses_damage_parse_check" CHECK (("character_tier_best_parses"."damage_parse_state" = 'available' AND "character_tier_best_parses"."damage_percentile" IS NOT NULL AND "character_tier_best_parses"."damage_percentile" >= 0 AND "character_tier_best_parses"."damage_percentile" <= 100) OR ("character_tier_best_parses"."damage_parse_state" IN ('not_applicable', 'unavailable') AND "character_tier_best_parses"."damage_percentile" IS NULL)),
	CONSTRAINT "character_tier_best_parses_healing_parse_check" CHECK (("character_tier_best_parses"."healing_parse_state" = 'available' AND "character_tier_best_parses"."healing_percentile" IS NOT NULL AND "character_tier_best_parses"."healing_percentile" >= 0 AND "character_tier_best_parses"."healing_percentile" <= 100) OR ("character_tier_best_parses"."healing_parse_state" IN ('not_applicable', 'unavailable') AND "character_tier_best_parses"."healing_percentile" IS NULL)),
	CONSTRAINT "character_tier_best_parses_boss_damage_parse_check" CHECK (("character_tier_best_parses"."boss_damage_parse_state" = 'available' AND "character_tier_best_parses"."boss_damage_percentile" IS NOT NULL AND "character_tier_best_parses"."boss_damage_percentile" >= 0 AND "character_tier_best_parses"."boss_damage_percentile" <= 100) OR ("character_tier_best_parses"."boss_damage_parse_state" IN ('not_applicable', 'unavailable') AND "character_tier_best_parses"."boss_damage_percentile" IS NULL))
);--> statement-breakpoint
ALTER TABLE "character_tier_best_parses" ADD CONSTRAINT "character_tier_best_parses_evidence_run_id_character_evidence_runs_id_fk" FOREIGN KEY ("evidence_run_id") REFERENCES "public"."character_evidence_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "character_tier_best_parses_encounter_idx" ON "character_tier_best_parses" USING btree ("evidence_run_id","raid_id","boss_id");--> statement-breakpoint
CREATE INDEX "character_tier_best_parses_run_idx" ON "character_tier_best_parses" USING btree ("evidence_run_id");
