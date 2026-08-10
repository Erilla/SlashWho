CREATE TABLE "fingerprint_sweep_request_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fingerprint_sweep_request_events" ADD CONSTRAINT "fingerprint_sweep_request_events_reservation_id_fingerprint_sweep_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."fingerprint_sweep_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fingerprint_sweep_request_events_window_idx" ON "fingerprint_sweep_request_events" USING btree ("requested_at");