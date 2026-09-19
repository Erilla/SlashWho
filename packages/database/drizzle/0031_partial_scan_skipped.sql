-- A parse-only resume is partial with no limitation code of either kind (#367).
--
-- The completion check has been widened twice for the same reason: it encodes
-- "a partial run must name a shortfall", and each new way to fall short was
-- discovered by a run the check rejected. 0009 required `limitation_code`;
-- 0022 accepted `parse_limitation_code` alongside it (#290); this accepts a
-- run that deliberately did not scan.
--
-- Without it, every parse-only run whose work fitted inside its parse budget
-- was refused -- which is the run a nearly-finished character makes, so a
-- character failed more reliably the closer it came to being done.
ALTER TABLE "character_evidence_runs"
  DROP CONSTRAINT "character_evidence_runs_completion_limitations_check";--> statement-breakpoint
ALTER TABLE "character_evidence_runs"
  ADD CONSTRAINT "character_evidence_runs_completion_limitations_check" CHECK (("character_evidence_runs"."status" = 'complete' AND "character_evidence_runs"."limitation_code" IS NULL) OR ("character_evidence_runs"."status" = 'partial' AND ("character_evidence_runs"."limitation_code" IS NOT NULL OR "character_evidence_runs"."parse_limitation_code" IS NOT NULL OR "character_evidence_runs"."kill_scan_skipped")) OR "character_evidence_runs"."status" NOT IN ('complete', 'partial'));
