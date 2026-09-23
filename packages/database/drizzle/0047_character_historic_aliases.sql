CREATE TABLE "character_historic_aliases" (
  "character_id" uuid NOT NULL REFERENCES "characters"("id") ON DELETE CASCADE,
  "region" text NOT NULL,
  "realm_slug" text NOT NULL,
  "normalized_name" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "character_historic_aliases_pkey" PRIMARY KEY ("character_id", "region", "realm_slug", "normalized_name")
);
--> statement-breakpoint
CREATE TABLE "dossier_character_exclusions" (
  "root_character_id" uuid NOT NULL REFERENCES "characters"("id") ON DELETE CASCADE,
  "region" text NOT NULL,
  "realm_slug" text NOT NULL,
  "normalized_name" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "dossier_character_exclusions_pkey" PRIMARY KEY ("root_character_id", "region", "realm_slug", "normalized_name")
);
--> statement-breakpoint
CREATE TABLE "character_alias_recollections" (
  "region" text NOT NULL,
  "realm_slug" text NOT NULL,
  "normalized_name" text NOT NULL,
  "requested_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "character_alias_recollections_pkey" PRIMARY KEY ("region", "realm_slug", "normalized_name")
);
--> statement-breakpoint
ALTER TABLE "character_evidence_runs"
  ADD COLUMN "historic_alias_progress" jsonb;
