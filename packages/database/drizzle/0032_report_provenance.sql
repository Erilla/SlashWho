ALTER TABLE "character_mythic_kills"
  ADD COLUMN "uploader" text;--> statement-breakpoint
ALTER TABLE "character_mythic_wipes"
  ADD COLUMN "guild_name" text,
  ADD COLUMN "guild_realm" text,
  ADD COLUMN "uploader" text;--> statement-breakpoint
ALTER TABLE "character_mythic_wipes"
  ADD CONSTRAINT "character_mythic_wipes_guild_identity_check"
  CHECK (("guild_name" IS NULL AND "guild_realm" IS NULL) OR ("guild_name" IS NOT NULL AND "guild_realm" IS NOT NULL));
