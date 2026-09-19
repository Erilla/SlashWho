CREATE TABLE "character_evidence_run_costs" (
	"run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	"credentials" text NOT NULL,
	"limitation_code" text,
	"parse_limitation_code" text,
	"points_spent" double precision,
	"points_limit_per_hour" integer,
	"points_remaining_before" double precision,
	"points_remaining_after" double precision,
	"request_cap_used" integer NOT NULL,
	"parse_request_cap_used" integer NOT NULL,
	"history_scan_requests" integer DEFAULT 0 NOT NULL,
	"zone_rankings_requests" integer DEFAULT 0 NOT NULL,
	"fight_parses_requests" integer DEFAULT 0 NOT NULL,
	"ranking_identities_requests" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "character_evidence_run_costs_pk" PRIMARY KEY("run_id","attempt"),
	CONSTRAINT "character_evidence_run_costs_credentials_check" CHECK ("character_evidence_run_costs"."credentials" in ('own', 'visitor'))
);
--> statement-breakpoint
ALTER TABLE "character_evidence_run_costs" ADD CONSTRAINT "character_evidence_run_costs_run_id_character_evidence_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."character_evidence_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "character_evidence_run_costs_recorded_idx" ON "character_evidence_run_costs" USING btree ("recorded_at");
