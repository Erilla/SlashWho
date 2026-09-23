CREATE TABLE applicant_source_state (
  source text PRIMARY KEY,
  initialized_at timestamptz NOT NULL,
  last_polled_at timestamptz NOT NULL
);

--> statement-breakpoint
CREATE TABLE applicant_source_counts (
  source text NOT NULL REFERENCES applicant_source_state(source),
  identity text NOT NULL,
  occurrence_count integer NOT NULL CHECK (occurrence_count >= 0),
  PRIMARY KEY (source, identity)
);

--> statement-breakpoint
CREATE TABLE applicant_source_intents (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL REFERENCES applicant_source_state(source),
  identity text NOT NULL,
  observed_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'done', 'suppressed')),
  claimed_until timestamptz,
  claimed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  retry_after timestamptz
);
--> statement-breakpoint
CREATE INDEX applicant_source_intents_pending_idx ON applicant_source_intents (source, sequence)
  WHERE state IN ('pending', 'claimed');
