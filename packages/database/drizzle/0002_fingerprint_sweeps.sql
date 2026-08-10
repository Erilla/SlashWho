ALTER TYPE "public"."discovery_source" ADD VALUE 'fingerprint';--> statement-breakpoint
CREATE TABLE "fingerprint_sweep_admissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue_order" bigserial NOT NULL,
	"discovery_run_id" uuid NOT NULL,
	"region" text NOT NULL,
	"realm_slug" text NOT NULL,
	"normalized_name" text NOT NULL,
	"request_cap" integer NOT NULL,
	"hourly_budget" integer NOT NULL,
	"cadence_cutoff" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fingerprint_sweep_admissions_request_cap_check" CHECK ("fingerprint_sweep_admissions"."request_cap" > 0),
	CONSTRAINT "fingerprint_sweep_admissions_hourly_budget_check" CHECK ("fingerprint_sweep_admissions"."hourly_budget" > 0)
);
--> statement-breakpoint
CREATE TABLE "fingerprint_sweep_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admission_id" uuid NOT NULL,
	"request_cap" integer NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"admitted_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"published" boolean,
	"limitation_code" text,
	CONSTRAINT "fingerprint_sweep_reservations_request_cap_check" CHECK ("fingerprint_sweep_reservations"."request_cap" > 0),
	CONSTRAINT "fingerprint_sweep_reservations_used_count_check" CHECK ("fingerprint_sweep_reservations"."used_count" >= 0 AND "fingerprint_sweep_reservations"."used_count" <= "fingerprint_sweep_reservations"."request_cap"),
	CONSTRAINT "fingerprint_sweep_reservations_expiry_check" CHECK ("fingerprint_sweep_reservations"."expires_at" > "fingerprint_sweep_reservations"."admitted_at")
);
--> statement-breakpoint
CREATE TABLE "fingerprint_sweep_states" (
	"region" text NOT NULL,
	"realm_slug" text NOT NULL,
	"normalized_name" text NOT NULL,
	"last_published_at" timestamp with time zone,
	CONSTRAINT "fingerprint_sweep_states_pkey" PRIMARY KEY("region","realm_slug","normalized_name")
);
--> statement-breakpoint
ALTER TABLE "fingerprint_sweep_admissions" ADD CONSTRAINT "fingerprint_sweep_admissions_discovery_run_id_discovery_runs_id_fk" FOREIGN KEY ("discovery_run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fingerprint_sweep_reservations" ADD CONSTRAINT "fingerprint_sweep_reservations_admission_id_fingerprint_sweep_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."fingerprint_sweep_admissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fingerprint_sweep_admissions_waiting_idx" ON "fingerprint_sweep_admissions" USING btree ("status","requested_at","queue_order");--> statement-breakpoint
CREATE INDEX "fingerprint_sweep_admissions_root_idx" ON "fingerprint_sweep_admissions" USING btree ("region","realm_slug","normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "fingerprint_sweep_reservations_admission_idx" ON "fingerprint_sweep_reservations" USING btree ("admission_id");--> statement-breakpoint
CREATE INDEX "fingerprint_sweep_reservations_expiry_idx" ON "fingerprint_sweep_reservations" USING btree ("expires_at");