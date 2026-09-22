CREATE TABLE "character_evidence_cutting_edges" (
	"evidence_run_id" uuid NOT NULL,
	"achievement_id" text NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "character_evidence_cutting_edges_pk" PRIMARY KEY("evidence_run_id", "achievement_id")
);
--> statement-breakpoint
ALTER TABLE "character_evidence_cutting_edges" ADD CONSTRAINT "character_evidence_cutting_edges_evidence_run_id_character_evidence_runs_id_fk" FOREIGN KEY ("evidence_run_id") REFERENCES "public"."character_evidence_runs"("id") ON DELETE cascade ON UPDATE no action;
