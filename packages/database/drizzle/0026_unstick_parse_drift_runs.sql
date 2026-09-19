-- One-off: release the characters stalled by the conflated drift code (#349).
--
-- `parse_schema_drift` carries no retry, and `retry_after_at` is the only
-- signal the resume sweep reads, so a character whose last completed run
-- raised it waits out its full freshness window and only returns if somebody
-- loads its dossier. That was tolerable while drift was rare; #346 stopped the
-- parse budget masking it and it landed on 7 of 10 characters at once.
--
-- Setting the deadline to now makes `isEvidenceFresh` false immediately and
-- hands them to the resume sweep, which re-collects them under the split codes
-- this migration ships with. A character whose drift is genuinely structural
-- raises `parse_schema_drift` again and stalls again -- correctly, and this
-- time saying so specifically rather than standing in for both cases.
--
-- Scoped to completed runs that are the character's newest, so it cannot
-- disturb an in-flight collection or resurrect a superseded one.
UPDATE "character_evidence_runs" AS stalled
   SET "retry_after_at" = now()
 WHERE stalled."status" IN ('complete', 'partial')
   AND stalled."parse_limitation_code" = 'parse_schema_drift'
   AND stalled."retry_after_at" IS NULL
   AND stalled."completed_at" = (
         SELECT max(newest."completed_at")
           FROM "character_evidence_runs" AS newest
          WHERE newest."region" = stalled."region"
            AND newest."realm_slug" = stalled."realm_slug"
            AND newest."normalized_name" = stalled."normalized_name"
            AND newest."status" IN ('complete', 'partial')
       );
