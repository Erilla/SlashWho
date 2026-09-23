CREATE TABLE "character_attendance_searches" (
	"region" text NOT NULL,
	"realm_slug" text NOT NULL,
	"normalized_name" text NOT NULL,
	"guild_region" text NOT NULL,
	"guild_realm" text NOT NULL,
	"guild_name" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"collection_version" integer NOT NULL,
	"searched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_attendance_searches_pkey" PRIMARY KEY("region","realm_slug","normalized_name","guild_region","guild_realm","guild_name","verified_at")
);
--> statement-breakpoint
ALTER TABLE "character_evidence_run_costs"
  ADD COLUMN "verified_kills_skipped_empty" integer;
