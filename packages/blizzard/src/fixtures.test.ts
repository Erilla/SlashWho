import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const fixtureDirectory = fileURLToPath(
  new URL("../../../tests/fixtures/blizzard/", import.meta.url)
);

// A table row: | `name.json` | synthetic or recorded | source | shape |
const rowPattern = /^\|\s*`([^`]+\.json)`\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/;

function readmeRows(): { file: string; provenance: string; source: string }[] {
  return readFileSync(resolve(fixtureDirectory, "README.md"), "utf8")
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = rowPattern.exec(line);
      return match
        ? [{ file: match[1]!, provenance: match[2]!, source: match[3]! }]
        : [];
    });
}

describe("Blizzard fixture provenance", () => {
  // Break caught: a fixture added without saying whether it was recorded or
  // hand-built, and from what, is how #39's guessed shapes became certified.
  it("lists every fixture file in the README, and only fixtures that exist", () => {
    const files = readdirSync(fixtureDirectory)
      .filter((file) => file.endsWith(".json"))
      .sort();
    const listed = readmeRows()
      .map((row) => row.file)
      .sort();

    expect(listed).toEqual(files);
  });

  it("gives every listed fixture a provenance and a source", () => {
    for (const row of readmeRows()) {
      expect(["synthetic", "recorded"], row.file).toContain(row.provenance);
      expect(row.source, row.file).not.toBe("");
    }
  });
});
