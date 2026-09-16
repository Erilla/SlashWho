ALTER TABLE "fingerprint_sweep_states"
  ADD COLUMN "continuation_failures" integer NOT NULL DEFAULT 0;
