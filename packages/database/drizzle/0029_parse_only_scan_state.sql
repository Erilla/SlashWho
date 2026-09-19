ALTER TABLE "character_evidence_runs"
  ADD COLUMN "kill_scan_skipped" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "character_evidence_runs"
  ADD COLUMN "kill_scan_completed_at" timestamp with time zone;
