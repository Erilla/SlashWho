import { describe, expect, it } from "vitest";

import { deduplicateCharacters, type DiscoveredCharacter } from "./deduplicate";

const first: DiscoveredCharacter = {
  key: { region: "eu", realm: "silvermoon", name: "ryii" },
  displayName: "Ryii",
  className: "Mage",
  level: 80,
  raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii",
  source: "input"
};

describe("deduplicateCharacters", () => {
  it("keeps the first observation for each canonical character key", () => {
    // Break caught: duplicate observations could create duplicate snapshot members.
    expect(
      deduplicateCharacters([
        first,
        {
          ...first,
          displayName: "RYII",
          source: "claimed"
        },
        {
          key: { region: "us", realm: "area-52", name: "other" },
          displayName: "Other",
          className: "Priest",
          level: 78,
          raiderIoUrl: "https://raider.io/characters/us/area-52/other",
          source: "claimed"
        }
      ])
    ).toEqual([
      first,
      {
        key: { region: "us", realm: "area-52", name: "other" },
        displayName: "Other",
        className: "Priest",
        level: 78,
        raiderIoUrl: "https://raider.io/characters/us/area-52/other",
        source: "claimed"
      }
    ]);
  });
});
