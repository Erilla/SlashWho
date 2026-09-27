ALTER TABLE "character_evidence_runs"
  ADD COLUMN "root_region" text,
  ADD COLUMN "root_realm_slug" text,
  ADD COLUMN "root_normalized_name" text;
--> statement-breakpoint
ALTER TABLE "character_evidence_runs"
  ADD CONSTRAINT "character_evidence_runs_root_check"
  CHECK (
    ("root_region" IS NULL AND "root_realm_slug" IS NULL AND "root_normalized_name" IS NULL)
    OR ("root_region" IS NOT NULL AND "root_realm_slug" IS NOT NULL AND "root_normalized_name" IS NOT NULL)
  );
