import { expect, it } from "vitest";

import {
  lookupJournalEncounter,
  lookupRaidBossByName,
  lookupRaiderIoBoss,
  lookupRaidByName
} from "./raid-catalogue";

it.each([
  ["Sporefall", "sporefall"],
  ["The Tidebound Grotto", "the-tidebound-grotto"],
  ["The Venomous Abyss", "the-venomous-abyss"]
])("maps the published Raider.IO raid %s", (name, slug) => {
  expect(lookupRaidByName(name)?.raiderIoRaidSlug).toBe(slug);
});

it("maps Rinn's Sszorak evidence to the published leaderboard", () => {
  expect(lookupRaiderIoBoss("The Venomous Abyss", "Sszorak")).toEqual({
    raidSlug: "the-venomous-abyss",
    bossSlug: "sszorak"
  });
  expect(lookupRaiderIoBoss("The Dreamrift", "Unknown")).toBeNull();
});

it("maps a Blizzard Journal encounter to its generated raid and boss metadata", () => {
  expect(lookupJournalEncounter("2602")).toEqual({
    raidId: "1273",
    raidName: "Nerub-ar Palace",
    bossId: "2602",
    bossName: "Queen Ansurek",
    bossOrder: 8,
    isFinalBoss: true,
    raiderIoBossSlug: null,
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
    tierOrdinal: 20,
    raiderIoRaidSlug: "nerubar-palace",
    imageUrl: expect.stringMatching(/^https:\/\//)
  });
});
