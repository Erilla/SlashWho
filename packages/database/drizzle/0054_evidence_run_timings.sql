ALTER TABLE "character_evidence_run_costs"
  ADD COLUMN "duration_ms" integer,
  ADD COLUMN "queue_wait_ms" integer,
  ADD COLUMN "warcraft_logs_ms" integer,
  ADD COLUMN "warcraft_logs_historic_alias_ms" integer,
  ADD COLUMN "db_ms" integer,
  ADD COLUMN "db_max_call_name" text;
