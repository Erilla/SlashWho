CREATE TYPE "public"."caller_class" AS ENUM('anonymous', 'bot');--> statement-breakpoint
CREATE TYPE "public"."discovery_run_status" AS ENUM('queued', 'running', 'retrying', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."discovery_source" AS ENUM('input', 'claimed', 'declared_main', 'profile_guess');--> statement-breakpoint
CREATE TYPE "public"."snapshot_state" AS ENUM('complete', 'partial');--> statement-breakpoint
CREATE TABLE "characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"region" text NOT NULL,
	"realm_slug" text NOT NULL,
	"normalized_name" text NOT NULL,
	"display_name" text NOT NULL,
	"class_name" text NOT NULL,
	"level" integer NOT NULL,
	"raider_io_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"root_region" text NOT NULL,
	"root_realm_slug" text NOT NULL,
	"root_normalized_name" text NOT NULL,
	"root_character_id" uuid,
	"queue_job_id" text,
	"status" "discovery_run_status" DEFAULT 'queued' NOT NULL,
	"caller_class" "caller_class" NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"snapshot_id" uuid
);
--> statement-breakpoint
CREATE TABLE "negative_character_cache" (
	"region" text NOT NULL,
	"realm_slug" text NOT NULL,
	"normalized_name" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "negative_character_cache_pkey" PRIMARY KEY("region","realm_slug","normalized_name")
);
--> statement-breakpoint
CREATE TABLE "rate_limit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"caller_bucket_hash" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshot_characters" (
	"snapshot_id" uuid NOT NULL,
	"character_id" uuid NOT NULL,
	"display_order" integer NOT NULL,
	"discovery_source" "discovery_source" NOT NULL,
	"display_name" text NOT NULL,
	"class_name" text NOT NULL,
	"level" integer NOT NULL,
	"raider_io_url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"root_character_id" uuid NOT NULL,
	"discovery_run_id" uuid NOT NULL,
	"state" "snapshot_state" NOT NULL,
	"limitation_code" text,
	"refreshed_at" timestamp with time zone NOT NULL,
	"character_count" integer NOT NULL,
	CONSTRAINT "snapshots_state_limitation_check" CHECK (("snapshots"."state" = 'complete' AND "snapshots"."limitation_code" IS NULL) OR ("snapshots"."state" = 'partial' AND "snapshots"."limitation_code" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "suppressed_characters" (
	"region" text NOT NULL,
	"realm_slug" text NOT NULL,
	"normalized_name" text NOT NULL,
	"suppressed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "suppressed_characters_pkey" PRIMARY KEY("region","realm_slug","normalized_name")
);
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_root_character_id_characters_id_fk" FOREIGN KEY ("root_character_id") REFERENCES "public"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_characters" ADD CONSTRAINT "snapshot_characters_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_characters" ADD CONSTRAINT "snapshot_characters_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_root_character_id_characters_id_fk" FOREIGN KEY ("root_character_id") REFERENCES "public"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_discovery_run_id_discovery_runs_id_fk" FOREIGN KEY ("discovery_run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "characters_canonical_key_idx" ON "characters" USING btree ("region","realm_slug","normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_runs_one_active_root_idx" ON "discovery_runs" USING btree ("root_region","root_realm_slug","root_normalized_name") WHERE "discovery_runs"."status" in ('queued', 'running', 'retrying');--> statement-breakpoint
CREATE INDEX "negative_character_cache_expiry_idx" ON "negative_character_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "rate_limit_events_bucket_expiry_idx" ON "rate_limit_events" USING btree ("caller_bucket_hash","expires_at");--> statement-breakpoint
CREATE INDEX "rate_limit_events_expiry_idx" ON "rate_limit_events" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "snapshot_characters_membership_idx" ON "snapshot_characters" USING btree ("snapshot_id","character_id");--> statement-breakpoint
CREATE UNIQUE INDEX "snapshot_characters_display_order_idx" ON "snapshot_characters" USING btree ("snapshot_id","display_order");--> statement-breakpoint
CREATE UNIQUE INDEX "snapshots_discovery_run_idx" ON "snapshots" USING btree ("discovery_run_id");--> statement-breakpoint
CREATE INDEX "snapshots_root_refreshed_idx" ON "snapshots" USING btree ("root_character_id","refreshed_at");--> statement-breakpoint
CREATE INDEX "suppressed_characters_expiry_idx" ON "suppressed_characters" USING btree ("expires_at");