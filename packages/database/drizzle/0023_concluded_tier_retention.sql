CREATE TYPE "public"."evidence_collection_domain" AS ENUM('kills', 'parses', 'tier_bests');--> statement-breakpoint
CREATE TABLE "character_terminal_tiers" (
	"region" text NOT NULL,
	"realm_slug" text NOT NULL,
	"normalized_name" text NOT NULL,
	"raid_id" text NOT NULL,
	"domain" "evidence_collection_domain" NOT NULL,
	"collection_version" integer NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_terminal_tiers_pkey" PRIMARY KEY("region","realm_slug","normalized_name","raid_id","domain")
);--> statement-breakpoint
ALTER TABLE "character_mythic_kills" ADD COLUMN "collected_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "character_mythic_kills" AS k
   SET "collected_at" = r."completed_at"
  FROM "character_evidence_runs" AS r
 WHERE r."id" = k."evidence_run_id" AND r."completed_at" IS NOT NULL;
