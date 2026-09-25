ALTER TABLE "character_evidence_runs"
  ADD COLUMN "publication_scope" text DEFAULT 'full' NOT NULL;
--> statement-breakpoint
ALTER TABLE "character_evidence_runs"
  ADD CONSTRAINT "character_evidence_runs_publication_scope_check"
  CHECK (
    "publication_scope" = 'full' OR
    ("publication_scope" = 'tier' AND "mode" = 'tier_search')
  );
