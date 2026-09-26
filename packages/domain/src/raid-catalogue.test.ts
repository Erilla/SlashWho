import { expect, it } from "vitest";

import {
  lookupJournalEncounter,
  lookupRaidBossByName,
  lookupRaiderIoBoss,
  lookupRaidByName,
  lookupRaidCurrentContentWindow,
  mythicDifficultyExistedDuring,
  raidContentWindowOpenedBetween,
  raidOffersMythicRankings,
  raidTierConclusion,
  supportedRaidCatalogue
} from "./raid-catalogue";
import currentContentWindowSnapshot from "./raid-current-content-windows.generated.json";

/** A kill named only by its Warcraft Logs zone, as the history scan sees it. */
function evidenceIn(raidName: string) {
  return { raidName, bossName: "Unknown", journalBossId: null };
}

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
// discards every Mythic kill in that raid, because currentness() cannot judge
// it. Since #326 an unwindowed raid also reads as `unknown` to
// `raidTierConclusion`, so it can never be marked terminal and one kill in it
// pins a veteran's scan floor to the bottom of their history -- which is how
// the last gap went unnoticed for months. Every catalogued raid must resolve
// to a window from one source or the other, so the next gap fails the build.
it("covers every catalogued raid with a current-content window", () => {
  const uncovered = supportedRaidCatalogue()
    .filter((raid) => lookupRaidCurrentContentWindow(raid.raidId) === null)
    .map((raid) => `${raid.raidId} ${raid.raidName}`)
    .sort();
  expect(uncovered).toEqual([]);
});

// The provenance is the point: a generated window is a union across regions,
// a curated one is a sourced release date, and they are not the same quantity.
// Only the raids the schedule source cannot reach may read as curated.
it("attributes every window to the source it actually came from", () => {
  const bySource = supportedRaidCatalogue().reduce<Record<string, string[]>>(
    (acc, raid) => {
      const window = lookupRaidCurrentContentWindow(raid.raidId);
      if (window) (acc[window.source] ??= []).push(raid.raidName);
      return acc;
    },
    {}
  );
  expect(bySource["blizzard-release-dates"]?.sort()).toEqual([
    "Blackrock Foundry",
    "Hellfire Citadel",
    "Highmaul",
    "Siege of Orgrimmar"
  ]);
  expect(bySource["raiderio-raiding-static-data"]).toHaveLength(25);
});

// Break caught: `457` is Blackrock Foundry and `477` is Highmaul, which is the
// opposite of the order they released in -- easy to transpose, and a transposed
// pair still satisfies every count and provenance check above. Pin each curated
// window to its raid by name, and pin the chain: each one ends where the next
// opens, and Hellfire Citadel meets the generated schedule's first raid.
it("chains the curated windows in release order, by name", () => {
  const windowOf = (raidName: string) => {
    const raid = lookupRaidByName(raidName);
    if (raid === null) throw new Error(`uncatalogued: ${raidName}`);
    return lookupRaidCurrentContentWindow(raid.raidId);
  };
  const order = [
    "Siege of Orgrimmar",
    "Highmaul",
    "Blackrock Foundry",
    "Hellfire Citadel"
  ];
  expect(order.map((raidName) => windowOf(raidName)?.startsAt)).toEqual([
    "2013-09-10T00:00:00.000Z",
    "2014-12-02T00:00:00.000Z",
    "2015-02-03T00:00:00.000Z",
    "2015-06-23T00:00:00.000Z"
  ]);
  // Each close is the next tier's opening, recorded as exactly that.
  expect(
    order.slice(0, -1).map((raidName) => windowOf(raidName)?.endsAt)
  ).toEqual(order.slice(1).map((raidName) => windowOf(raidName)?.startsAt));
  // And the last one meets the generated schedule rather than overlapping it.
  expect(windowOf("Hellfire Citadel")?.endsAt).toBe(
    windowOf("The Emerald Nightmare")?.startsAt
  );
});

// Break caught: a curated window exists only because the schedule source does
// not reach that raid. If coverage ever extends backwards the generated value
// has to take over on its own, rather than waiting for someone to notice.
it("prefers the generated schedule wherever it reaches", () => {
  const curated = supportedRaidCatalogue().filter(
    (raid) =>
      lookupRaidCurrentContentWindow(raid.raidId)?.source ===
      "blizzard-release-dates"
  );
  const served = curated.filter(
    (raid) =>
      raid.raiderIoRaidSlug !== null &&
      raid.raiderIoRaidSlug in currentContentWindowSnapshot.windows
  );
  expect(served.map((raid) => raid.raidName)).toEqual([]);
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

// A stale dossier read runs only the newest page for a character whose tiers
// are all terminal (#540). A tier that opened since its last clean scan has no
// mark for anyone yet, so that read has to see the opening and collect in full.
it("sees a raid window that opened inside the interval, and none outside it", () => {
  // The Tidebound Grotto's regional opening.
  expect(
    raidContentWindowOpenedBetween(
      new Date("2026-08-18T00:00:00.000Z"),
      new Date("2026-08-19T00:00:00.000Z")
    )
  ).toBe(true);
  expect(
    raidContentWindowOpenedBetween(
      new Date("2026-08-19T00:00:00.000Z"),
      new Date("2026-08-25T00:00:00.000Z")
    )
  ).toBe(false);
  // The interval is half-open: a window that opened at `since` was already
  // open when that scan ran.
  expect(
    raidContentWindowOpenedBetween(
      new Date("2026-08-18T15:00:00.000Z"),
      new Date("2026-08-25T00:00:00.000Z")
    )
  ).toBe(false);
});

it("counts an unreadable interval as a window having opened", () => {
  expect(
    raidContentWindowOpenedBetween(
      new Date(Number.NaN),
      new Date("2026-08-25T00:00:00.000Z")
    )
  ).toBe(true);
});

it("reads every current-content window's opening as a time", () => {
  const unreadable = supportedRaidCatalogue().flatMap((raid) => {
    const window = lookupRaidCurrentContentWindow(raid.raidId);
    return window !== null && Number.isNaN(Date.parse(window.startsAt))
      ? [raid.raidId]
      : [];
  });
  // An unreadable opening reads as a window opening at every moment, which
  // would quietly send every stale read back to a full collection.
  expect(unreadable).toEqual([]);
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
    endsAt: "2025-03-05T23:00:00.000Z",
    source: "raiderio-raiding-static-data"
  });
});

// Break caught: historic tiers have no reviewed window at all, and dropping
// their kills is the defect this window source exists to fix.
it("covers a historic tier the reviewed windows never reached", () => {
  expect(lookupRaidCurrentContentWindow("1195")).toEqual({
    startsAt: "2022-03-01T15:00:00.000Z",
    endsAt: "2022-08-03T23:00:00.000Z",
    source: "raiderio-raiding-static-data"
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

it("reports a raid whose current-content window has closed as concluded", () => {
  expect(
    raidTierConclusion("The Dreamrift", new Date("2026-09-18T00:00:00.000Z"))
  ).toBe("concluded");
});

it("reports a raid still inside its window as current", () => {
  expect(
    raidTierConclusion("The Dreamrift", new Date("2026-06-01T00:00:00.000Z"))
  ).toBe("current");
});

it("reports an open-ended window as current however late it is read", () => {
  expect(
    raidTierConclusion(
      "The Venomous Abyss",
      new Date("2099-01-01T00:00:00.000Z")
    )
  ).toBe("current");
});

// Break caught: `current_content_window_unknown` is live on five characters of
// one dossier today. An undatable raid must keep being re-queried, because
// freezing evidence we cannot place in time is worse than re-reading it.
it("reports a raid the catalogue cannot place in time as unknown", () => {
  expect(
    raidTierConclusion("Not A Raid", new Date("2026-09-18T00:00:00.000Z"))
  ).toBe("unknown");
  expect(
    raidTierConclusion("VS / DR / MQD", new Date("2026-09-18T00:00:00.000Z"))
  ).toBe("unknown");
});

it("reports an unreadable instant as unknown rather than concluded", () => {
  expect(raidTierConclusion("The Dreamrift", new Date(Number.NaN))).toBe(
    "unknown"
  );
});

it("concludes a tier at its boundary, not after a further delay", () => {
  expect(
    raidTierConclusion("The Dreamrift", new Date("2026-08-19T23:00:00.000Z"))
  ).toBe("concluded");
  expect(
    raidTierConclusion("The Dreamrift", new Date("2026-08-19T22:59:59.999Z"))
  ).toBe("current");
});

// Break caught: Warcraft Logs answers `zoneRankings(difficulty: 5)` for a zone
// that never had Mythic difficulty with an error envelope, which the collector
// read as schema drift -- a limitation that stops the tier settling, so the
// wasted request is re-paid on every run, forever (#351).
it("offers Mythic rankings only for a raid it can place after Mythic existed", () => {
  // Siege of Orgrimmar opened as a Mists tier and was still current content
  // when the Warlords pre-patch renamed its top difficulty to Mythic, so it is
  // the boundary case the rule has to keep.
  expect(raidOffersMythicRankings(evidenceIn("Siege of Orgrimmar"))).toBe(true);
  expect(raidOffersMythicRankings(evidenceIn("The Venomous Abyss"))).toBe(true);
});

it("does not offer Mythic rankings for a zone it cannot place as a raid", () => {
  // Throne of Thunder is a Mists tier whose top difficulty was Heroic, and
  // Challenge Modes is not a raid at all. Both are asked about only because a
  // fight without its own game zone falls back to the report's.
  expect(raidOffersMythicRankings(evidenceIn("Throne of Thunder"))).toBe(false);
  expect(raidOffersMythicRankings(evidenceIn("Challenge Modes"))).toBe(false);
});

it("offers Mythic rankings for a raid only its boss names", () => {
  expect(
    raidOffersMythicRankings({
      raidName: "VS / DR / MQD",
      bossName: "Imperator Averzian",
      journalBossId: null
    })
  ).toBe(true);
});

it("judges a raid's Mythic difficulty by when its window closed", () => {
  // Throne of Thunder's real window, which the catalogue does not hold: it
  // closed more than a year before Mythic difficulty existed.
  expect(
    mythicDifficultyExistedDuring({
      startsAt: "2013-03-05T00:00:00.000Z",
      endsAt: "2013-09-10T00:00:00.000Z",
      source: "blizzard-release-dates"
    })
  ).toBe(false);
  // Siege of Orgrimmar's, which straddles the Warlords pre-patch.
  expect(
    mythicDifficultyExistedDuring({
      startsAt: "2013-09-10T00:00:00.000Z",
      endsAt: "2014-12-02T00:00:00.000Z",
      source: "blizzard-release-dates"
    })
  ).toBe(true);
  expect(
    mythicDifficultyExistedDuring({
      startsAt: "2026-08-01T00:00:00.000Z",
      endsAt: null,
      source: "raiderio-raiding-static-data"
    })
  ).toBe(true);
});
