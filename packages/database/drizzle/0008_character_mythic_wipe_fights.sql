DROP INDEX "character_mythic_wipes_run_boss_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "character_mythic_wipes_run_fight_idx" ON "character_mythic_wipes" USING btree ("evidence_run_id","fight_url");
