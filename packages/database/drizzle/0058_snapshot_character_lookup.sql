-- 0011_snapshot_character_lookup.sql added this index but never got a journal
-- entry, so no database ever created it. IF NOT EXISTS covers any database
-- where it was created by hand.
CREATE INDEX IF NOT EXISTS "snapshot_characters_character_idx" ON "snapshot_characters" USING btree ("character_id");
