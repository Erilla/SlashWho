-- One-off: release characters stalled by the unnamed dungeon fight bug (#361).
--
-- `schema_drift` carries no retry, and `retry_after_at` is the only signal the
-- resume sweep reads. The decoder fix prevents this specific drift from being
-- created again, but existing runs otherwise remain stranded indefinitely.
-- A genuinely structural schema drift will raise the same limitation again,
-- which is the correct outcome after it has had one retry under the fixed
-- decoder.
--
-- Scope this to completed runs that are the character's newest, so it cannot
-- disturb an in-flight collection or resurrect a superseded one.
UPDATE "character_evidence_runs" AS stalled
   SET "retry_after_at" = now()
 WHERE stalled."status" IN ('complete', 'partial')
   AND stalled."limitation_code" = 'schema_drift'
   AND stalled."retry_after_at" IS NULL
   AND stalled."completed_at" = (
         SELECT max(newest."completed_at")
           FROM "character_evidence_runs" AS newest
          WHERE newest."region" = stalled."region"
            AND newest."realm_slug" = stalled."realm_slug"
            AND newest."normalized_name" = stalled."normalized_name"
            AND newest."status" IN ('complete', 'partial')
       );
