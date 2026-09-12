import { expect, it } from "vitest";

import {
  lookupJournalEncounter,
  lookupRaidBossByName,
  lookupRaidByName
} from "./raid-catalogue";

it("maps a Blizzard Journal encounter to its generated raid and boss metadata", () => {
  expect(lookupJournalEncounter("2602")).toEqual({
    raidId: "1273",
    raidName: "Nerub-ar Palace",
    bossId: "2602",
    bossName: "Queen Ansurek",
    bossOrder: 8,
    imageUrl: expect.stringMatching(/^https:\/\//)
  });
});

it("does not invent metadata for an unknown Journal encounter", () => {
  expect(lookupJournalEncounter("99999999")).toBeNull();
});

it("matches an exact normalized raid and boss name when WCL has no Journal ID", () => {
  expect(
    lookupRaidBossByName("Nerub-ar Palace", "Queen Ansurek")
  ).toMatchObject({
    raidId: "1273",
    bossId: "2602",
    bossOrder: 8
  });
});

it("matches a unique generated raid name independently of its boss", () => {
  expect(lookupRaidByName("Nerub-ar Palace")).toEqual({
    raidId: "1273",
    raidName: "Nerub-ar Palace",
    imageUrl: expect.stringMatching(/^https:\/\//)
  });
});
