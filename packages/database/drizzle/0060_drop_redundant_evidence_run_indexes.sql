-- Each table's unique index already leads with evidence_run_id, so it serves
-- every lookup (and cascade delete) by run. These only added write cost to the
-- tables every evidence publish rewrites.
DROP INDEX IF EXISTS "character_mythic_kills_run_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "character_tier_best_parses_run_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "character_mythic_wipes_run_idx";
