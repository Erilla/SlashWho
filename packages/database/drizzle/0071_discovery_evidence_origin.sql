ALTER TABLE "character_evidence_runs"
  DROP CONSTRAINT "character_evidence_runs_origin_check";
--> statement-breakpoint
ALTER TABLE "character_evidence_runs"
  ADD CONSTRAINT "character_evidence_runs_origin_check"
  CHECK ("origin" IN (
    'dossier_initial', 'dossier_read', 'refresh', 'rebuild',
    'historic_alias', 'tier_search', 'resume_sweep', 'applicant_sheet',
    'discovery', 'fingerprint_admission', 'unknown'
  ));
