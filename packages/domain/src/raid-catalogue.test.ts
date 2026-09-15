import { expect, it } from "vitest";

import {
  lookupJournalEncounter,
  lookupRaidBossByName,
  lookupRaiderIoBoss,
  lookupRaidByName,
  lookupRaidCurrentContentWindow,
  raidsWithoutCurrentContentWindow,
  supportedRaidCatalogue
} from "./raid-catalogue";

it("exposes supported raids newest-first with bosses in natural order", () => {
  // Break caught: gap rows cannot be complete or stable when callers must
  // reconstruct catalogue order from lookup-only APIs.
  const first = supportedRaidCatalogue();
  expect(first[0]?.raidName).toBe("The Venomous Abyss");
  expect(first[0]?.encounters.map((boss) => boss.bossOrder)).toEqual(
    [...(first[0]?.encounters ?? [])]
      .map((boss) => boss.bossOrder)
      .sort((a, b) => a - b)
  );

  const originalName = first[0]?.raidName;
  Reflect.set(first[0] ?? {}, "raidName", "Changed");
  expect(supportedRaidCatalogue()[0]?.raidName).toBe(originalName);
});

it("does not publish the Dragon Isles world-boss container as a raid", () => {
  expect(lookupRaidByName("Dragon Isles")).toBeNull();
  expect(
    supportedRaidCatalogue().some((raid) => raid.raidName === "Dragon Isles")
  ).toBe(false);
});

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
  expect(lookupRaiderIoBoss("Unknown raid", "Unknown")).toBeNull();
});

it("resolves the recorded combined WCL Midnight zone before ranking enrichment", () => {
  expect(lookupRaiderIoBoss("VS / DR / MQD", "Imperator Averzian")).toEqual({
    raidSlug: "tier-mn-1",
    bossSlug: "imperator-averzian"
  });
  expect(lookupRaiderIoBoss("VS / DR / MQD", "Fallen-King Salhadaar")).toEqual({
    raidSlug: "tier-mn-1",
    bossSlug: "fallenking-salhadaar"
  });
  expect(lookupRaiderIoBoss("VS / DR / MQD", "Queen Ansurek")).toBeNull();
  expect(
    lookupRaiderIoBoss("Mythic+ Season 1", "Imperator Averzian")
  ).toBeNull();
});

it.each([
  [
    "Manaforge Omega",
    "Dimensius, the All-Devouring",
    "manaforge-omega",
    "dimensius"
  ],
  [
    "The Voidspire",
    "Fallen-King Salhadaar",
    "tier-mn-1",
    "fallenking-salhadaar"
  ],
  ["The Voidspire", "Vaelgor & Ezzorak", "tier-mn-1", "vaelgor-ezzorak"],
  [
    "The Dreamrift",
    "Chimaerus the Undreamt God",
    "tier-mn-1",
    "chimaerus-the-undreamt-god"
  ],
  ["March on Quel'Danas", "Midnight Falls", "tier-mn-1", "midnight-falls"]
])(
  "uses published identifiers for %s / %s",
  (raid, boss, raidSlug, bossSlug) => {
    expect(lookupRaiderIoBoss(raid, boss)).toEqual({ raidSlug, bossSlug });
  }
);

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

// Break caught: a catalogued raid with no current-content window silently
// discards every Mythic kill in that raid, because currentness() cannot
// judge it. A new tier must fail here rather than in a reviewer's dossier.
it("covers every catalogued raid with a current-content window", () => {
  const uncovered = supportedRaidCatalogue()
    .filter((raid) => lookupRaidCurrentContentWindow(raid.raidId) === null)
    .map((raid) => raid.raidId)
    .sort();
  expect(uncovered).toEqual([...raidsWithoutCurrentContentWindow].sort());
});

it("orders every current-content window start before its end", () => {
  const inverted = supportedRaidCatalogue().flatMap((raid) => {
    const window = lookupRaidCurrentContentWindow(raid.raidId);
    return window !== null &&
      window.endsAt !== null &&
      Date.parse(window.startsAt) >= Date.parse(window.endsAt)
      ? [raid.raidId]
      : [];
  });
  expect(inverted).toEqual([]);
});

// Break caught: generating the windows alone moved Sporefall's opening from the
// reviewed 2026-05-20 to Raider.IO's 2026-06-16, which withholds real kills in
// that gap. Taking the earlier known start keeps them.
it("takes the earlier known opening when the two sources disagree", () => {
  expect(lookupRaidCurrentContentWindow("1305")?.startsAt).toBe(
    "2026-05-20T00:00:00.000Z"
  );
});

// Break caught: a reviewed null end meant no close had been reviewed yet, not
// that the tier never closes. Treating it as open-ended admitted legacy farm
// clears once Raider.IO knew the real close.
it("closes a tier whose reviewed end was still unreviewed", () => {
  expect(lookupRaidCurrentContentWindow("1305")?.endsAt).toBe(
    "2026-08-19T23:00:00.000Z"
  );
});

// Break caught: preferring the generated end would have moved Manaforge Omega's
// close earlier than the reviewed one, withholding real progression kills.
it("keeps the later known close when the reviewed end outlasts the generated one", () => {
  expect(lookupRaidCurrentContentWindow("1302")?.endsAt).toBe(
    "2026-03-17T00:00:00.000Z"
  );
});

it("widens a reviewed window on both sides from the generated schedule", () => {
  expect(lookupRaidCurrentContentWindow("1273")).toEqual({
    startsAt: "2024-09-10T15:00:00.000Z",
    endsAt: "2025-03-05T23:00:00.000Z"
  });
});

// Break caught: historic tiers have no reviewed window at all, and dropping
// their kills is the defect this window source exists to fix.
it("covers a historic tier the reviewed windows never reached", () => {
  expect(lookupRaidCurrentContentWindow("1195")).toEqual({
    startsAt: "2022-03-01T15:00:00.000Z",
    endsAt: "2022-08-03T23:00:00.000Z"
  });
});

it("leaves an unclosed current tier open-ended", () => {
  expect(lookupRaidCurrentContentWindow("1317")?.endsAt).toBeNull();
});

// Break caught: requiring the encounter's own name on a Journal creature left
// 85 of 227 encounters with no artwork, because councils and subtitled bosses
// name their creatures individually. Every catalogued boss is depicted
// upstream, so a null here is a generator defect, not missing Blizzard data.
it("catalogues artwork for every raid and boss", () => {
  const withoutArtwork = supportedRaidCatalogue().flatMap((raid) => [
    ...(raid.imageUrl === null ? [raid.raidName] : []),
    ...raid.encounters
      .filter((encounter) => encounter.imageUrl === null)
      .map((encounter) => `${raid.raidName} / ${encounter.bossName}`)
  ]);
  expect(withoutArtwork).toEqual([]);
});
