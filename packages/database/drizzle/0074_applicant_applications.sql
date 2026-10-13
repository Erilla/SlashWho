ALTER TABLE applicant_source_state
  ADD COLUMN submitted_serial_mark double precision;

CREATE TABLE applicant_source_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL REFERENCES applicant_source_state(source),
  root_intent_sequence bigint NOT NULL UNIQUE REFERENCES applicant_source_intents(sequence),
  root_identity text NOT NULL,
  submitted_serial double precision NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  last_checked_at timestamptz,
  closed_at timestamptz,
  over_cap boolean NOT NULL DEFAULT false,
  linked_count integer NOT NULL DEFAULT 0,
  suppressed_count integer NOT NULL DEFAULT 0,
  same_character_count integer NOT NULL DEFAULT 0,
  skipped_region_count integer NOT NULL DEFAULT 0,
  skipped_excluded_count integer NOT NULL DEFAULT 0,
  skipped_cross_group_count integer NOT NULL DEFAULT 0,
  expired_count integer NOT NULL DEFAULT 0
);

CREATE INDEX applicant_source_applications_root_idx
  ON applicant_source_applications (root_identity, submitted_serial);
CREATE INDEX applicant_source_applications_open_idx
  ON applicant_source_applications (last_checked_at NULLS FIRST, created_at)
  WHERE closed_at IS NULL;

CREATE TABLE applicant_source_application_members (
  application_id uuid NOT NULL REFERENCES applicant_source_applications(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  identity text NOT NULL,
  member_intent_sequence bigint REFERENCES applicant_source_intents(sequence),
  outcome text CHECK (outcome IN ('linked', 'suppressed', 'same_character', 'skipped_region', 'skipped_excluded', 'skipped_cross_group', 'expired')),
  PRIMARY KEY (application_id, ordinal)
);

CREATE INDEX applicant_source_application_members_waiting_idx
  ON applicant_source_application_members (identity)
  WHERE member_intent_sequence IS NULL;

-- A constant default is metadata-only on PostgreSQL 11+, so existing rows are
-- reviewer links without a rewrite.
ALTER TABLE manual_dossier_connections
  ADD COLUMN origin text NOT NULL DEFAULT 'dossier'
    CONSTRAINT manual_dossier_connections_origin_check CHECK (origin IN ('dossier', 'applicant_sheet')),
  ADD COLUMN applicant_application_id uuid
    REFERENCES applicant_source_applications(id) ON DELETE SET NULL;
