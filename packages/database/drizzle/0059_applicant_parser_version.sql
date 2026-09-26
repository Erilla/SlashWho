-- Existing sources were baselined by the parser before accented realms were
-- read (version 1); the next poll re-baselines them under the current one.
ALTER TABLE applicant_source_state ADD COLUMN parser_version integer NOT NULL DEFAULT 1;
