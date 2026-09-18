CREATE TABLE "character_evidence_collections" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "character_evidence_collections" ADD CONSTRAINT "character_evidence_collections_run_id_character_evidence_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."character_evidence_runs"("id") ON DELETE cascade ON UPDATE no action;
