ALTER TABLE "character_evidence_runs"
  ADD COLUMN "mode" text DEFAULT 'full' NOT NULL,
  ADD COLUMN "tier_search_raid_id" text;
--> statement-breakpoint
ALTER TABLE "character_evidence_runs"
  ADD CONSTRAINT "character_evidence_runs_mode_check"
  CHECK (
    ("mode" = 'full' AND "tier_search_raid_id" IS NULL) OR
    ("mode" = 'tier_search' AND "tier_search_raid_id" IS NOT NULL)
  );
--> statement-breakpoint
CREATE INDEX "character_evidence_runs_tier_search_idx"
  ON "character_evidence_runs"
  ("region", "realm_slug", "normalized_name", "tier_search_raid_id", "created_at")
  WHERE "mode" = 'tier_search';
--> statement-breakpoint
ALTER TABLE "character_evidence_run_costs"
  ADD COLUMN "mode" text DEFAULT 'full' NOT NULL,
  ADD COLUMN "character_guilds_requests" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "tier_search_raid_id" text,
  ADD COLUMN "tier_search_outcome" text,
  ADD COLUMN "tier_search_requests" integer,
  ADD COLUMN "tier_search_guilds" integer,
  ADD COLUMN "tier_search_reports_hydrated" integer,
  ADD COLUMN "tier_search_recovered_kills" integer,
  ADD COLUMN "tier_search_recovered_wipes" integer;
