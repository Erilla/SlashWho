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
  deferred_observed_at timestamptz,
  PRIMARY KEY (source, identity)
);

--> statement-breakpoint
CREATE TABLE applicant_source_intents (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL REFERENCES applicant_source_state(source),
  identity text NOT NULL,
  canonical_identity text,
  observed_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'done', 'suppressed')),
  claimed_until timestamptz,
  claimed_at timestamptz,
  charged_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  retry_after timestamptz
);
--> statement-breakpoint
CREATE INDEX applicant_source_intents_pending_idx ON applicant_source_intents (source, sequence)
  WHERE state IN ('pending', 'claimed');

--> statement-breakpoint
CREATE TABLE applicant_suppression_history (
  region text NOT NULL,
  realm_slug text NOT NULL,
  normalized_name text NOT NULL,
  suppressed_at timestamptz NOT NULL,
  expires_at timestamptz,
  ended_at timestamptz
);

--> statement-breakpoint
CREATE INDEX applicant_suppression_history_lookup_idx
  ON applicant_suppression_history (region, realm_slug, normalized_name, suppressed_at);

--> statement-breakpoint
INSERT INTO applicant_suppression_history
  (region, realm_slug, normalized_name, suppressed_at, expires_at)
SELECT region, realm_slug, normalized_name, suppressed_at, expires_at
FROM suppressed_characters;

--> statement-breakpoint
CREATE FUNCTION record_applicant_suppression() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    UPDATE applicant_suppression_history
    SET ended_at = NEW.suppressed_at
    WHERE region = OLD.region AND realm_slug = OLD.realm_slug
      AND normalized_name = OLD.normalized_name AND ended_at IS NULL;
  END IF;
  INSERT INTO applicant_suppression_history
    (region, realm_slug, normalized_name, suppressed_at, expires_at)
  VALUES
    (NEW.region, NEW.realm_slug, NEW.normalized_name, NEW.suppressed_at, NEW.expires_at);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint
CREATE TRIGGER applicant_suppression_history_trigger
  AFTER INSERT OR UPDATE ON suppressed_characters
  FOR EACH ROW EXECUTE FUNCTION record_applicant_suppression();
