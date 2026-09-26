import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The drizzle migrator applies a journal entry only when its `when` is later
// than the newest `created_at` already recorded in the database, so an entry
// that does not sort after its predecessor passes on a fresh database and is
// silently skipped everywhere else. See docs/contributing.md.

type JournalEntry = { idx: number; when: number; tag: string };

const migrationsFolder = new URL("../drizzle/", import.meta.url);

function journalProblems(
  entries: readonly JournalEntry[],
  sqlFiles: readonly string[]
): string[] {
  const problems: string[] = [];
  entries.forEach((entry, position) => {
    if (entry.idx !== position) {
      problems.push(`${entry.tag}: idx ${entry.idx} at position ${position}`);
    }
    const previous = entries[position - 1];
    if (!previous) return;
    if (entry.when <= previous.when) {
      problems.push(
        `${entry.tag}: when ${entry.when} is not after ${previous.tag} (${previous.when})`
      );
    }
    if (entry.tag <= previous.tag) {
      problems.push(`${entry.tag}: tag does not sort after ${previous.tag}`);
    }
  });
  const tags = new Set(entries.map(({ tag }) => tag));
  const files = new Set(sqlFiles.map((file) => file.replace(/\.sql$/, "")));
  for (const tag of tags) {
    if (!files.has(tag))
      problems.push(`${tag}: journal entry has no .sql file`);
  }
  for (const file of files) {
    if (!tags.has(file)) problems.push(`${file}.sql: no journal entry`);
  }
  if (tags.size !== entries.length) problems.push("duplicate journal tag");
  return problems;
}

describe("migration journal", () => {
  it("applies every migration file, in order, on an existing database", () => {
    // Break caught: a hand-written entry dated before its predecessor, or a
    // .sql file with no journal entry (the orphaned 0011), never reaches a
    // database that already applied the newest migration.
    const journal = JSON.parse(
      readFileSync(new URL("meta/_journal.json", migrationsFolder), "utf8")
    ) as { entries: JournalEntry[] };
    const sqlFiles = readdirSync(migrationsFolder).filter((file) =>
      file.endsWith(".sql")
    );

    expect(journal.entries.length).toBeGreaterThan(0);
    expect(journalProblems(journal.entries, sqlFiles)).toEqual([]);
  });

  it("holds no drizzle-kit snapshots", () => {
    // Break caught: drizzle-kit generate diffs schema.ts against the newest
    // snapshot, which no longer describes the migrated database. Migrations
    // are hand-written; a snapshot here means someone reintroduced generate.
    expect(readdirSync(new URL("meta/", migrationsFolder))).toEqual([
      "_journal.json"
    ]);
  });

  it("reports each way an entry can be skipped or lost", () => {
    // Break caught: a check that cannot fail proves nothing about the journal.
    const entry = (idx: number, when: number, tag: string) => ({
      idx,
      when,
      tag
    });

    expect(
      journalProblems(
        [entry(0, 10, "0000_a"), entry(1, 10, "0001_b"), entry(3, 5, "0002_c")],
        ["0000_a.sql", "0001_b.sql", "0002_c.sql"]
      )
    ).toEqual([
      "0001_b: when 10 is not after 0000_a (10)",
      "0002_c: idx 3 at position 2",
      "0002_c: when 5 is not after 0001_b (10)"
    ]);
    expect(
      journalProblems(
        [entry(0, 1, "0001_b"), entry(1, 2, "0000_a")],
        ["0000_a.sql", "0001_b.sql"]
      )
    ).toEqual(["0000_a: tag does not sort after 0001_b"]);
    expect(
      journalProblems(
        [entry(0, 1, "0000_a"), entry(1, 2, "0002_c")],
        ["0000_a.sql", "0001_orphan.sql"]
      )
    ).toEqual([
      "0002_c: journal entry has no .sql file",
      "0001_orphan.sql: no journal entry"
    ]);
  });
});
