import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// drizzle-orm's migrator iterates journal entries, never the folder, and
// applies an entry only when its `when` is later than the newest one already
// applied. A .sql file without an entry never runs anywhere, and an entry
// dated before its predecessor is skipped on every existing database.
const folder = new URL("../drizzle/", import.meta.url);
const journal = JSON.parse(
  readFileSync(new URL("meta/_journal.json", folder), "utf8")
) as { entries: Array<{ idx: number; when: number; tag: string }> };

describe("migration journal", () => {
  it("has exactly one entry for every migration file", () => {
    const files = readdirSync(folder)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.slice(0, -".sql".length))
      .sort();

    expect(journal.entries.map(({ tag }) => tag).sort()).toEqual(files);
  });

  // Tag numbers skip 0011, whose orphaned file was replaced by a later entry
  // rather than back-filled, so only their order is fixed.
  it("indexes entries in order of their migration number", () => {
    journal.entries.forEach(({ idx }, position) => {
      expect(idx).toBe(position);
    });
    const numbers = journal.entries.map(({ tag }) => Number(tag.slice(0, 4)));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("dates every entry strictly after the one before it", () => {
    for (let position = 1; position < journal.entries.length; position += 1) {
      expect(journal.entries[position]!.when).toBeGreaterThan(
        journal.entries[position - 1]!.when
      );
    }
  });
});
