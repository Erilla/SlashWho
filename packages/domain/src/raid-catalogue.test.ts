import { expect, it } from "vitest";

import {
  lookupJournalEncounter,
  lookupRaidBossByLegacyName,
  lookupRaidBossByName,
  lookupRaiderIoBoss,
  lookupRaidByName,
  lookupRaidEncounterForEvidence,
  lookupRaidForEvidence,
  lookupSiblingRaidBossByName,
  lookupUniqueRaidBossByName,
  lookupRaidCurrentContentWindow,
  mythicDifficultyExistedDuring,
  raidContentWindowOpenedBetween,
  raidOffersMythicRankings,
  raidTierConclusion,
  raidTiers,
  raiderIoRaidContentWindowEnd,
  supportedRaidCatalogue
} from "./raid-catalogue";
import currentContentWindowSnapshot from "./raid-current-content-windows.generated.json";

it("groups the catalogue into tiers, folding side raids into their parent tier", () => {
  // Pinned by name and date: a count or an ordering check passes over a raid
  // filed under the wrong tier, which is exactly what would split or merge a
  // guild's bar on the timeline (#611).
  expect(raidTiers().map((tier) => [tier.startsOn, tier.name])).toEqual([
    ["2013-09-10", "Siege of Orgrimmar"],
    ["2014-12-02", "Highmaul"],
    ["2015-02-03", "Blackrock Foundry"],
    ["2015-06-23", "Hellfire Citadel"],
    ["2016-09-20", "The Emerald Nightmare / Trial of Valor"],
    ["2017-01-17", "The Nighthold"],
    ["2017-06-20", "Tomb of Sargeras"],
    ["2017-11-28", "Antorus, the Burning Throne"],
    ["2018-09-04", "Uldir"],
    ["2019-01-22", "Battle of Dazar'alor / Crucible of Storms"],
    ["2019-07-09", "The Eternal Palace"],
    ["2020-01-21", "Ny'alotha, the Waking City"],
    ["2020-12-08", "Castle Nathria"],
    ["2021-07-06", "Sanctum of Domination"],
    ["2022-03-01", "Sepulcher of the First Ones"],
    ["2022-12-13", "Vault of the Incarnates"],
    ["2023-05-09", "Aberrus, the Shadowed Crucible"],
    ["2023-11-14", "Amirdrassil, the Dream's Hope"],
    ["2024-09-10", "Nerub-ar Palace"],
    ["2025-03-04", "Liberation of Undermine"],
    ["2025-08-12", "Manaforge Omega"],
    [
      "2026-03-17",
      "March on Quel'Danas / The Dreamrift / The Voidspire / Sporefall"
    ],
    ["2026-08-18", "The Tidebound Grotto / The Venomous Abyss"]
  ]);
});

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

// Every spelling below is what Warcraft Logs reports, read from its zone
// encounter lists on 2026-09-27; none of those encounters carries a usable
// journalID, so the name is all the catalogue has to go on. Pinned by name and
// id, because a count passes just as happily over a transposed mapping.
it.each([
  [
    "Liberation of Undermine",
    "One-Armed Bandit",
    "2644",
    "The One-Armed Bandit"
  ],
  [
    "Liberation of Undermine",
    "The One-Armed Bandit",
    "2644",
    "The One-Armed Bandit"
  ],
  ["Battle of Dazar'alor", "Mekkatorque", "2334", "High Tinker Mekkatorque"],
  [
    "Antorus, The Burning Throne",
    "The Defense of Eonar",
    "2025",
    "Eonar the Life-Binder"
  ],
  ["Ny'alotha, the Waking City", "Prophet Skitra", "2369", "The Prophet Skitra"]
])(
  "resolves Warcraft Logs' %s / %s to Journal boss %s",
  (raidName, bossName, bossId, journalName) => {
    expect(lookupRaidBossByName(raidName, bossName)).toMatchObject({
      bossId,
      bossName: journalName
    });
  }
);

// Warcraft Logs' `Ny'alotha` zone names no Journal raid, and it carries Eternal
// Palace and Battle of Dazar'alor kills as well as Ny'alotha's own, so only the
// boss can place them. Giving the zone an alias would pin all of them to
// Ny'alotha, and withhold the rest.
it.each([
  ["Prophet Skitra", "2369"],
  ["Wrathion", "2368"],
  ["The Defense of Eonar", "2025"],
  ["Mekkatorque", "2334"],
  ["One-Armed Bandit", "2644"],
  ["Abyssal Commander Sivara", "2352"]
])("places a %s kill in a zone no raid is named for", (bossName, bossId) => {
  expect(lookupRaidByName("Ny'alotha")).toBeNull();
  expect(lookupUniqueRaidBossByName(bossName)).toMatchObject({ bossId });
});

it("keeps the legacy prefix rule inside a named raid only", () => {
  const raid = lookupRaidByName("Ny'alotha, the Waking City")!;
  expect(lookupRaidBossByLegacyName(raid.raidId, "Wrathion")).toMatchObject({
    bossId: "2368"
  });
  expect(lookupUniqueRaidBossByName("Grong")).toBeNull();
});

it("does not let a Warcraft Logs alias claim a boss in another raid", () => {
  expect(
    lookupRaidBossByName("Manaforge Omega", "One-Armed Bandit")
  ).toBeNull();
  expect(lookupRaidBossByName("Nerub-ar Palace", "Mekkatorque")).toBeNull();
});

// Break caught: Warcraft Logs ranking zone 53 is named `The Venomous Abyss`
// but also holds The Tidebound Grotto's only boss. The raid name was known, so
// the unique boss name was never consulted, and every such kill, wipe and
// parse was withheld as an unmatched encounter (#729). Stored rows on test show
// the reverse too: Venomous Abyss bosses under `The Tidebound Grotto`.
it.each([
  ["The Venomous Abyss", "Nymrissa Wavecaller", "1317", "2849"],
  ["The Tidebound Grotto", "The Lost Explorers", "1320", "2894"],
  ["The Tidebound Grotto", "Entombed Sentinels", "1320", "2874"]
])(
  "places a %s-labelled %s kill in its own raid of the same tier",
  (raidName, bossName, raidId, bossId) => {
    const evidence = { raidName, bossName, journalBossId: null };
    expect(lookupRaidEncounterForEvidence(evidence)).toMatchObject({
      raidId,
      bossId
    });
    expect(lookupRaidForEvidence(evidence)?.raidId).toBe(raidId);
  }
);

it("never places a boss from another tier by a raid name's sibling rule", () => {
  // Undermine's One-Armed Bandit is unique in the catalogue, but Manaforge
  // Omega is the next tier: a mislabelled zone must not move it across.
  const evidence = {
    raidName: "Manaforge Omega",
    bossName: "One-Armed Bandit",
    journalBossId: null
  };
  expect(
    lookupSiblingRaidBossByName(evidence.raidName, evidence.bossName)
  ).toBeNull();
  expect(lookupRaidEncounterForEvidence(evidence)).toBeNull();
  expect(lookupRaidForEvidence(evidence)?.raidName).toBe("Manaforge Omega");
});

it("still names the raid when the boss cannot be placed", () => {
  expect(
    lookupRaidForEvidence({
      raidName: "The Venomous Abyss",
      bossName: "Unknown",
      journalBossId: null
    })?.raidId
  ).toBe("1320");
});

// Break caught: the Journal lists a Horde and an Alliance copy of these fights
// under one name, while Warcraft Logs reports each as a single encounter. The
// name matched both copies, so it matched neither, and every kill was withheld
// as an unmatched encounter while two empty cards stood in for the boss.
it.each([
  ["Battle of Dazar'alor", "Champion of the Light", "2333", "2344"],
  ["Battle of Dazar'alor", "Jadefire Masters", "2323", "2341"],
  ["Siege of Orgrimmar", "Galakras", "868", "881"]
])(
  "treats the two faction copies of %s / %s as one boss",
  (raidName, bossName, bossId, twinId) => {
    expect(lookupRaidBossByName(raidName, bossName)).toMatchObject({ bossId });
    expect(lookupJournalEncounter(twinId)).toMatchObject({ bossId, bossName });
    const roster = supportedRaidCatalogue().find(
      (raid) => raid.raidName === raidName
    )?.encounters;
    expect(roster?.filter((boss) => boss.bossName === bossName)).toHaveLength(
      1
    );
    expect(roster?.some((boss) => boss.bossId === twinId)).toBe(false);
  }
);

it("keeps both Grongs, whose Journal and Warcraft Logs names tell them apart", () => {
  const raid = lookupRaidByName("Battle of Dazar'alor")!;
  expect(
    lookupRaidBossByName("Battle of Dazar'alor", "Grong the Revenant")
  ).toMatchObject({ bossId: "2340" });
  expect(
    lookupRaidBossByName("Battle of Dazar'alor", "Grong, the Jungle Lord")
  ).toMatchObject({ bossId: "2325" });
  expect(lookupRaidBossByLegacyName(raid.raidId, "Grong")).toBeNull();
  expect(
    supportedRaidCatalogue()
      .find((entry) => entry.raidId === raid.raidId)
      ?.encounters.map((boss) => boss.bossName)
  ).toEqual([
    "Champion of the Light",
    "Grong, the Jungle Lord",
    "Grong, the Revenant",
    "Jadefire Masters",
    "Opulence",
    "Conclave of the Chosen",
    "King Rastakhan",
    "High Tinker Mekkatorque",
    "Stormwall Blockade",
    "Lady Jaina Proudmoore"
  ]);
});

// Raider.IO's boss slugs, read from its raiding static data on 2026-09-27.
// Mostly the Journal name slugged, but not always, so each case here is one
// where the Journal name would give the wrong answer or Warcraft Logs spells
// the boss differently.
it.each([
  [
    "Liberation of Undermine",
    "One-Armed Bandit",
    "liberation-of-undermine",
    "onearmed-bandit"
  ],
  [
    "Battle of Dazar'alor",
    "Mekkatorque",
    "battle-of-dazaralor",
    "high-tinker-mekkatorque"
  ],
  [
    "Battle of Dazar'alor",
    "Jadefire Masters",
    "battle-of-dazaralor",
    "jadefire-masters"
  ],
  [
    "Battle of Dazar'alor",
    "Champion of the Light",
    "battle-of-dazaralor",
    "champion-of-the-light"
  ],
  [
    "Battle of Dazar'alor",
    "Grong the Revenant",
    "battle-of-dazaralor",
    "grong"
  ],
  [
    "Battle of Dazar'alor",
    "Grong, the Jungle Lord",
    "battle-of-dazaralor",
    "grong"
  ],
  [
    "Antorus, The Burning Throne",
    "The Defense of Eonar",
    "antorus-the-burning-throne",
    "eonar-the-life-binder"
  ],
  [
    "Ny'alotha, the Waking City",
    "Prophet Skitra",
    "nyalotha-the-waking-city",
    "the-prophet-skitra"
  ],
  [
    "Ny'alotha, the Waking City",
    "Wrathion",
    "nyalotha-the-waking-city",
    "wrathion-the-black-emperor"
  ],
  ["Uldir", "Zek'voz", "uldir", "zekvoz-herald-of-nzoth"],
  ["The Eternal Palace", "Za'qul", "the-eternal-palace", "zaqul"],
  [
    "Sepulcher of the First Ones",
    "Skolex, the Insatiable Ravener",
    "sepulcher-of-the-first-ones",
    "skolex"
  ],
  [
    "Sepulcher of the First Ones",
    "Dausegne",
    "sepulcher-of-the-first-ones",
    "dausegne"
  ],
  [
    "Sepulcher of the First Ones",
    "Lihuvim, Principal Architect",
    "sepulcher-of-the-first-ones",
    "lihuvim"
  ],
  [
    "Sepulcher of the First Ones",
    "Halondrus the Reclaimer",
    "sepulcher-of-the-first-ones",
    "halondrus"
  ],
  [
    "Sanctum of Domination",
    "Fatescribe Roh-Kalo",
    "sanctum-of-domination",
    "fatescribe-rohkalo"
  ],
  [
    "Vault of the Incarnates",
    "Raszageth the Storm-Eater",
    "vault-of-the-incarnates",
    "raszageth-the-stormeater"
  ],
  [
    "The Emerald Nightmare",
    "Il'gynoth, Heart of Corruption",
    "the-emerald-nightmare",
    "ilgynoth-the-heart-of-corruption"
  ]
])(
  "asks Raider.IO about %s / %s by its published slug",
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

it("closes a Raider.IO raid when the last raid filed under its slug closes", () => {
  expect(raiderIoRaidContentWindowEnd("the-nighthold")).toBe(
    "2017-06-14T23:00:00.000Z"
  );
  // Three Journal raids share Raider.IO's opening Midnight tier; each has a
  // reviewed opening with no close, which yields to the snapshot's close.
  expect(raiderIoRaidContentWindowEnd("tier-mn-1")).toBe(
    "2026-08-19T23:00:00.000Z"
  );
  // Still open, and a slug nothing is filed under: neither has closed.
  expect(raiderIoRaidContentWindowEnd("the-venomous-abyss")).toBeNull();
  expect(raiderIoRaidContentWindowEnd("awakened-amirdrassil")).toBeNull();
});
