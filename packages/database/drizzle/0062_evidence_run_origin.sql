ALTER TABLE "character_evidence_runs"
  ADD COLUMN "origin" text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "character_evidence_runs"
  ADD CONSTRAINT "character_evidence_runs_origin_check"
  CHECK ("origin" IN (
    'dossier_initial', 'dossier_read', 'refresh', 'rebuild',
    'historic_alias', 'tier_search', 'resume_sweep', 'applicant_sheet',
    'fingerprint_admission', 'unknown'
  ));
--> statement-breakpoint
ALTER TABLE "character_evidence_run_costs"
  ADD COLUMN "origin" text DEFAULT 'unknown' NOT NULL;
