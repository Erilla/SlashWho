CREATE TYPE "public"."character_evidence_run_status" AS ENUM('queued', 'running', 'retrying', 'complete', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "character_evidence_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"region" text NOT NULL,
	"realm_slug" text NOT NULL,
	"normalized_name" text NOT NULL,
	"queue_job_id" text,
	"status" character_evidence_run_status DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"limitation_code" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "character_mythic_kills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_run_id" uuid NOT NULL,
	"source_fight_key" text NOT NULL,
	"raid_id" text NOT NULL,
	"raid_name" text NOT NULL,
	"boss_id" text NOT NULL,
	"boss_name" text NOT NULL,
	"journal_boss_id" text,
	"boss_order" integer NOT NULL,
	"is_final_boss" boolean NOT NULL,
	"killed_at" timestamp with time zone NOT NULL,
	"report_url" text NOT NULL,
	"fight_url" text NOT NULL,
	"guild_name" text,
	"guild_realm" text,
	"historic_world_rank" integer,
	CONSTRAINT "character_mythic_kills_guild_identity_check" CHECK (("character_mythic_kills"."guild_name" IS NULL AND "character_mythic_kills"."guild_realm" IS NULL) OR ("character_mythic_kills"."guild_name" IS NOT NULL AND "character_mythic_kills"."guild_realm" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "character_mythic_kills" ADD CONSTRAINT "character_mythic_kills_evidence_run_id_character_evidence_runs_id_fk" FOREIGN KEY ("evidence_run_id") REFERENCES "public"."character_evidence_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "character_evidence_runs_one_active_key_idx" ON "character_evidence_runs" USING btree ("region","realm_slug","normalized_name") WHERE "character_evidence_runs"."status" in ('queued', 'running', 'retrying');--> statement-breakpoint
CREATE INDEX "character_evidence_runs_completed_key_idx" ON "character_evidence_runs" USING btree ("region","realm_slug","normalized_name","completed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "character_mythic_kills_source_fight_idx" ON "character_mythic_kills" USING btree ("evidence_run_id","source_fight_key");--> statement-breakpoint
CREATE INDEX "character_mythic_kills_run_idx" ON "character_mythic_kills" USING btree ("evidence_run_id");