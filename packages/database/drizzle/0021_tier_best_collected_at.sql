ALTER TABLE "character_tier_best_parses" ADD COLUMN "collected_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "character_tier_best_parses" AS t
   SET "collected_at" = r."completed_at"
  FROM "character_evidence_runs" AS r
 WHERE r."id" = t."evidence_run_id" AND r."completed_at" IS NOT NULL;
