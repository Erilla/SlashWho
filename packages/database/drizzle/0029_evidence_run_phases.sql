CREATE TABLE "character_evidence_run_phases" (
	"run_id" uuid NOT NULL,
	"phase_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"state" text NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"limitation_code" text,
	CONSTRAINT "character_evidence_run_phases_pk" PRIMARY KEY("run_id","phase_id"),
	CONSTRAINT "character_evidence_run_phases_state_check" CHECK ("character_evidence_run_phases"."state" in ('pending', 'active', 'completed', 'skipped', 'limited', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "character_evidence_run_phases" ADD CONSTRAINT "character_evidence_run_phases_run_id_character_evidence_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."character_evidence_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "character_evidence_run_phases_order_idx" ON "character_evidence_run_phases" USING btree ("run_id","ordinal");
--> statement-breakpoint
CREATE UNIQUE INDEX "character_evidence_run_phases_order_idx" ON "character_evidence_run_phases" USING btree ("run_id","ordinal");
