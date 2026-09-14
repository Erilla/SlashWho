import { describe, expect, it } from "vitest";

import { formatCharacterDisplayName } from "./display-name";

describe("formatCharacterDisplayName", () => {
  it("uses title case for the first Unicode character and lower case for the rest", () => {
    // Break caught: code-unit-based formatting leaves supplementary-plane
    // letters lowercased even though the name is otherwise normalized.
    expect(formatCharacterDisplayName("𐐨LAR")).toBe("𐐀lar");
  });

  it.each([
    ["rYiI", "Ryii"],
    ["éLÉONORE", "Éléonore"],
    ["o'NEIL", "O'neil"],
    ["aNNa-MARIE", "Anna-marie"]
  ])(
    "formats %s as %s without changing supported punctuation",
    (value, expected) => {
      // Break caught: display casing could leak through or apostrophes and hyphens
      // could be removed while formatting a character name.
      expect(formatCharacterDisplayName(value)).toBe(expected);
    }
  );
});
