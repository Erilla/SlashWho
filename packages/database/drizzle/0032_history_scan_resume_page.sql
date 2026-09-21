ALTER TABLE "character_evidence_runs"
  ADD COLUMN "kill_scan_resume_page" integer;
--> statement-breakpoint
ALTER TABLE "character_evidence_runs"
  ADD COLUMN "kill_scan_resume_head_report_code" text;
