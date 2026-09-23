ALTER TABLE "character_evidence_run_costs"
  ADD COLUMN "guild_attendance_requests" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "report_hydration_requests" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "raiderio_historic_outcome" text,
  ADD COLUMN "raiderio_historic_ms" integer,
  ADD COLUMN "verified_kills_searched" integer,
  ADD COLUMN "attendance_recovered_kills" integer;
