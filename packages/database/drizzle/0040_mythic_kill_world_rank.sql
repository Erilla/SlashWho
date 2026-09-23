ALTER TABLE "character_mythic_kills"
  ADD COLUMN "historic_world_rank" integer;

ALTER TABLE "character_mythic_kills"
  ADD CONSTRAINT "character_mythic_kills_historic_world_rank_check"
  CHECK ("historic_world_rank" IS NULL OR "historic_world_rank" > 0);
