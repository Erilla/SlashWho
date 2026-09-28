-- Raider.IO tiers each character has read after they settled (#732 follow-up).
--
-- A tier whose raids all closed before the character's kill-scan floor is
-- asked once, and not again while its mark is current, so its logged first
-- kills are collected without asking on every run. Keyed by character, not by
-- run: nothing cascades to it, and a rebuild clears it with the terminal
-- marks.
CREATE TABLE "character_raiderio_tier_reads" (
	"region" text NOT NULL,
	"realm_slug" text NOT NULL,
	"normalized_name" text NOT NULL,
	"tier_ordinal" integer NOT NULL,
	"collection_version" integer NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "character_raiderio_tier_reads_pkey" PRIMARY KEY("region","realm_slug","normalized_name","tier_ordinal")
);
--> statement-breakpoint
-- Whether a published first kill's presence was checked against a visible
-- roster. False until checked; existing rows are checked again once.
ALTER TABLE "character_raiderio_first_kills" ADD COLUMN "presence_checked" boolean DEFAULT false NOT NULL;
