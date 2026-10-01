ALTER TABLE fingerprint_sweep_admissions
  ADD COLUMN attempt_base integer CHECK (attempt_base >= 0),
  ADD COLUMN dispatch_kind text CHECK (dispatch_kind IN ('ordinary', 'continuation')),
  ADD COLUMN execution_job_id uuid,
  ADD COLUMN execution_attempt integer NOT NULL DEFAULT 0 CHECK (execution_attempt >= 0),
  ADD COLUMN execution_max_attempts integer CHECK (execution_max_attempts > 0),
  ADD COLUMN execution_token uuid,
  ADD COLUMN consumed_at timestamptz;
