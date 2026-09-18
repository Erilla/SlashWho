import { expect, it } from "vitest";

import { parseRebuildOperation } from "./rebuild-character.mts";

it("accepts the documented pnpm separator before the character URL", () => {
  // pnpm forwards the literal `--`, so reading it as the URL would make the
  // documented invocation fail.
  expect(
    parseRebuildOperation([
      "--",
      "https://raider.io/characters/eu/silvermoon/Ryii"
    ])
  ).toEqual({
    characterUrl: "https://raider.io/characters/eu/silvermoon/Ryii"
  });
});

it("reads the character URL without a separator", () => {
  expect(
    parseRebuildOperation(["https://raider.io/characters/eu/silvermoon/Ryii"])
  ).toEqual({
    characterUrl: "https://raider.io/characters/eu/silvermoon/Ryii"
  });
});

it("refuses to rebuild without a character", () => {
  // A rebuild costs a whole history, so it must never be startable by accident.
  expect(() => parseRebuildOperation([])).toThrow("character_url_required");
  expect(() => parseRebuildOperation(["--"])).toThrow("character_url_required");
});
