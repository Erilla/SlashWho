ALTER TABLE "fingerprint_sweep_states" ADD COLUMN "resume_after" text;
--> statement-breakpoint
ALTER TABLE "fingerprint_sweep_states" ADD COLUMN "resume_limitation_code" text;
--> statement-breakpoint
ALTER TABLE "fingerprint_sweep_states" ADD COLUMN "resume_snapshot_id" uuid;
--> statement-breakpoint
ALTER TABLE "fingerprint_sweep_states"
  ADD CONSTRAINT "fingerprint_sweep_states_resume_snapshot_id_fk"
  FOREIGN KEY ("resume_snapshot_id") REFERENCES "snapshots"("id")
  ON DELETE SET NULL;
