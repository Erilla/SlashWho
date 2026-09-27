-- Guild reads a discovery run lost to an upstream failure after its one retry
-- (#677). Rows written before this column existed read 0: they counted nothing.
ALTER TABLE discovery_runs ADD COLUMN guild_reads_dropped integer NOT NULL DEFAULT 0;
