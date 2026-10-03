CREATE TABLE raiderio_roster_profile_resolutions (
  region text NOT NULL,
  realm text NOT NULL,
  name text NOT NULL,
  historic_id bigint NOT NULL,
  resolver_version integer NOT NULL,
  resolved_id bigint,
  limitation_code text,
  answered_at timestamptz,
  last_attempt_at timestamptz NOT NULL,
  retry_not_before timestamptz,
  attempt_token uuid,
  lease_until timestamptz,
  PRIMARY KEY (region, realm, name, historic_id, resolver_version),
  CONSTRAINT roster_profile_historic_id_safe CHECK (historic_id BETWEEN 1 AND 9007199254740991),
  CONSTRAINT roster_profile_resolved_id_safe CHECK (resolved_id IS NULL OR resolved_id BETWEEN 1 AND 9007199254740991),
  CONSTRAINT roster_profile_answer_shape CHECK (
    (resolved_id IS NULL OR (limitation_code IS NULL AND answered_at IS NOT NULL))
    AND (answered_at IS NULL OR resolved_id IS NOT NULL OR (limitation_code IS NOT NULL AND limitation_code IN ('not_found', 'private', 'schema_drift')))
  ),
  CONSTRAINT roster_profile_lease_shape CHECK ((attempt_token IS NULL) = (lease_until IS NULL))
);
