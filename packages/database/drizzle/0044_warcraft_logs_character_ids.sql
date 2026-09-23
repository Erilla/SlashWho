CREATE TABLE "warcraft_logs_character_ids" (
  "region" text NOT NULL,
  "realm_slug" text NOT NULL,
  "normalized_name" text NOT NULL,
  "character_id" integer NOT NULL,
  "resolved_at" timestamp with time zone NOT NULL,
  CONSTRAINT "warcraft_logs_character_ids_pkey"
    PRIMARY KEY ("region", "realm_slug", "normalized_name"),
  CONSTRAINT "warcraft_logs_character_ids_positive"
    CHECK ("character_id" > 0)
);
--> statement-breakpoint
CREATE INDEX "warcraft_logs_character_ids_character_id_idx"
  ON "warcraft_logs_character_ids" ("character_id");
