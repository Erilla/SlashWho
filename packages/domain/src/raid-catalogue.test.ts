import { expect, it } from "vitest";

import { lookupJournalEncounter } from "./raid-catalogue";

it("maps a Blizzard Journal encounter to its generated raid and boss metadata", () => {
  expect(lookupJournalEncounter("2602")).toEqual({
    raidId: "1273",
    raidName: "Nerub-ar Palace",
    bossId: "2602",
    bossName: "Queen Ansurek",
    bossOrder: 8
  });
});

it("does not invent metadata for an unknown Journal encounter", () => {
  expect(lookupJournalEncounter("99999999")).toBeNull();
});
