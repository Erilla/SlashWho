CREATE TABLE "character_mythic_wipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_run_id" uuid NOT NULL,
	"raid_id" text NOT NULL,
	"raid_name" text NOT NULL,
	"boss_id" text NOT NULL,
	"boss_name" text NOT NULL,
	"journal_boss_id" text,
	"boss_order" integer NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"report_url" text NOT NULL,
	"fight_url" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "character_mythic_wipes" ADD CONSTRAINT "character_mythic_wipes_evidence_run_id_character_evidence_runs_id_fk" FOREIGN KEY ("evidence_run_id") REFERENCES "public"."character_evidence_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "character_mythic_wipes_run_boss_idx" ON "character_mythic_wipes" USING btree ("evidence_run_id","raid_id","boss_id");--> statement-breakpoint
CREATE INDEX "character_mythic_wipes_run_idx" ON "character_mythic_wipes" USING btree ("evidence_run_id");