ALTER TABLE "fingerprint_sweep_admissions" ADD COLUMN "dispatched_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "fingerprint_sweep_admissions_dispatch_idx" ON "fingerprint_sweep_admissions" USING btree ("status","dispatched_at","requested_at","queue_order");
