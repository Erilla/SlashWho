-- Raider.IO logged encounters with no Vantus data (#747).
--
-- Raider.IO sends `log.vantus: null` for some bosses (Rashok, the Elder, the
-- Jailer and others). A read row may now hold a null vantus_count, which means
-- "Raider.IO gave no Vantus data" and is never zero runes. The counts check
-- already passes a null.
ALTER TABLE "raiderio_logged_encounters" DROP CONSTRAINT "raiderio_logged_encounters_answer_check";
--> statement-breakpoint
ALTER TABLE "raiderio_logged_encounters" ADD CONSTRAINT "raiderio_logged_encounters_answer_check" CHECK (("unavailable_code" IS NULL AND "raid_slug" IS NOT NULL AND "boss_slug" IS NOT NULL AND "pulled_at" IS NOT NULL AND "defeated_at" IS NOT NULL AND "duration_ms" IS NOT NULL AND "item_level_average" IS NOT NULL AND "item_level_min" IS NOT NULL AND "item_level_max" IS NOT NULL AND "death_count" IS NOT NULL AND "roster_state" IS NOT NULL) OR ("unavailable_code" IN ('not_found', 'private', 'schema_drift') AND "raid_slug" IS NULL AND "boss_slug" IS NULL AND "pulled_at" IS NULL AND "defeated_at" IS NULL AND "duration_ms" IS NULL AND "guild_name" IS NULL AND "item_level_average" IS NULL AND "item_level_min" IS NULL AND "item_level_max" IS NULL AND "death_count" IS NULL AND "vantus_count" IS NULL AND "roster_state" IS NULL AND "share_raid_until" IS NULL));
--> statement-breakpoint
-- Every stored schema_drift refusal so far is an encounter refused for its
-- null Vantus data. Forget them, so each character's next run reads them as
-- first reads instead of waiting 30 days for the refusal to fall due. A
-- refusal is not evidence: no kill or roster row is removed, and a log that
-- really names another boss is refused again on that read.
DELETE FROM "raiderio_logged_encounters" WHERE "unavailable_code" = 'schema_drift';
