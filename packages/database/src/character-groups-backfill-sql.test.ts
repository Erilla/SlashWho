import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { REBUILD_SQL } from "./character-groups-backfill-sql";

it("rebuilds with exactly the migration's backfill statements", () => {
  // Break caught: the rebuild and the migration drifted, so a rebuild left
  // groups the replay then called drift.
  const migration = readFileSync(
    new URL("../drizzle/0069_character_groups.sql", import.meta.url),
    "utf8"
  );
  expect(migration).toContain(REBUILD_SQL.pinLatest.trim());
  expect(migration).toContain(REBUILD_SQL.pinSwept.trim());
  expect(migration).toContain(REBUILD_SQL.raiderio.trim());
  expect(migration).toContain(REBUILD_SQL.fingerprint.trim());
  expect(migration).toContain(
    REBUILD_SQL.markerAndLedger.replace("'rebuild'", "'backfill'").trim()
  );
});
