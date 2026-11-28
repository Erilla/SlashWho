/** One counting predicate for recompute, rebuild, audit and production reads.
 * Phase 2 retains phase 1's manual-half semantics; phase 3 changes it here.
 */
export const COUNTING_LINKS_WITH_STRENGTH = `
  SELECT DISTINCT connection.character_low_id AS a,
         connection.character_high_id AS b, connection.source AS source
  FROM character_connections connection
  WHERE connection.kind = 'observed'
    AND NOT EXISTS (
      SELECT 1 FROM character_connections rejection
      WHERE rejection.kind = 'rejected'
        AND rejection.character_low_id = connection.character_low_id
        AND rejection.character_high_id = connection.character_high_id
    )
  UNION
  SELECT manual.root_character_id, target.id, NULL
  FROM manual_dossier_connections manual
  JOIN characters target ON target.region = manual.connected_region
    AND target.realm_slug = manual.connected_realm_slug
    AND target.normalized_name = manual.connected_normalized_name
  WHERE target.id <> manual.root_character_id`;

export const COUNTING_LINKS = `SELECT DISTINCT a, b FROM (${COUNTING_LINKS_WITH_STRENGTH}) counting`;
export const COUNTING_LINKS_FROM = `SELECT a, b FROM (${COUNTING_LINKS}) counting_from WHERE a = ANY($1::uuid[]) OR b = ANY($1::uuid[])`;
