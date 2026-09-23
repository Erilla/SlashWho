ALTER TABLE "character_evidence_runs"
  ADD COLUMN "ranked_backfill_cursor" jsonb,
  ADD COLUMN "ranked_backfill_attempted" boolean DEFAULT false NOT NULL;
